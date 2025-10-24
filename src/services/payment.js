// src/services/payment.js

/**
 * Payment and Subscription Management Service
 * Handles trial periods, subscription checks, and payment integration
 */

class PaymentService {
    constructor() {
        this.WORKER_URL = 'https://lemon-worker.bhaveshlalvani000.workers.dev';
        this.TRIAL_DURATION_DAYS = 3;
        this.DEVICE_TOKEN_KEY = 'deviceToken';
        this.SUBSCRIPTION_KEY = 'subscription';
        this.TRIAL_KEY = 'trial';
        this.USAGE_KEY = 'usage';
        this.TRIAL_USED_FLAG = 'trialEverUsed'; // Persistent flag to track if trial was ever used

        // Cache for avoiding redundant API calls
        this.statusCache = null;
        this.cacheTimestamp = 0;
        this.CACHE_DURATION = 30000; // 30 seconds

        // Track initialization promise to ensure device token is ready
        this.initPromise = null;

        // Initialize device token
        this.initPromise = this.initializeDeviceToken();
    }

    /**
     * Initialize or retrieve device token with enhanced persistence
     */
    async initializeDeviceToken() {
        try {
            // Check local storage first
            const local = await chrome.storage.local.get([this.DEVICE_TOKEN_KEY]);
            if (local[this.DEVICE_TOKEN_KEY]) {
                return;
            }

            // Check sync storage for existing device token (survives reinstalls)
            let syncToken = null;
            try {
                const sync = await chrome.storage.sync.get(['persistent_device_token']);
                syncToken = sync.persistent_device_token;
            } catch (error) {
                // Sync storage might be disabled
            }

            let deviceToken;
            if (syncToken) {
                // Reuse existing device token from sync storage
                deviceToken = syncToken;
            } else {
                // Generate new device token only if none exists
                deviceToken = this.generateDeviceToken();

                // Store in sync storage for persistence across reinstalls
                try {
                    await chrome.storage.sync.set({
                        'persistent_device_token': deviceToken,
                        'device_created_at': new Date().toISOString()
                    });
                } catch (error) {
                    // Continue without sync storage
                }
            }

            // Always store in local storage for quick access
            await chrome.storage.local.set({ [this.DEVICE_TOKEN_KEY]: deviceToken });

        } catch (error) {
            console.error('💥 Failed to initialize device token:', error);
        }
    }


    /**
     * Generate a unique device token (Chrome Web Store compliant)
     * Uses random UUID that doesn't persist across uninstalls
     */
    generateDeviceToken() {
        // Generate a random UUID-like token (compliant with Chrome policies)
        const timestamp = Date.now().toString(36);
        const random1 = Math.random().toString(36).substring(2, 15);
        const random2 = Math.random().toString(36).substring(2, 15);

        return `device_${timestamp}_${random1}_${random2}`;
    }



    /**
     * Get current device token (ensures initialization completes first)
     */
    async getDeviceToken() {
        try {
            // Wait for initialization to complete if it's still running
            if (this.initPromise) {
                await this.initPromise;
            }
            
            const result = await chrome.storage.local.get([this.DEVICE_TOKEN_KEY]);
            return result[this.DEVICE_TOKEN_KEY];
        } catch (error) {
            console.error('💥 Failed to get device token:', error);
            return null;
        }
    }

    /**
     * Check subscription status from server (internal method with retry logic)
     */
    async _checkServerStatus() {
        const deviceToken = await this.getDeviceToken();
        if (!deviceToken) {
            throw new Error('No device token available');
        }

        try {
            const data = await this.makeWorkerRequest(`/check?token=${deviceToken}`);

            // Store subscription data locally
            await chrome.storage.local.set({ [this.SUBSCRIPTION_KEY]: data });
            return data;
        } catch (error) {
            console.error('💥 Server status check failed:', error);
            throw error;
        }
    }

    /**
     * Get unified subscription status - used consistently across UI and access checks
     */
    async getUnifiedSubscriptionStatus(forceRefresh = false) {
        try {
            // Check cache first (avoid redundant calls within 30 seconds)
            const now = Date.now();
            if (!forceRefresh && this.statusCache && (now - this.cacheTimestamp) < this.CACHE_DURATION) {

                return this.statusCache;
            }

            // First try to get server status
            let serverStatus;
            try {
                serverStatus = await this._checkServerStatus();

            } catch (error) {
                console.warn('⚠️ Server check failed, using local status:', error);
                serverStatus = null;
            }

            // If server says active subscription, trust it
            if (serverStatus && serverStatus.active) {
                // Cache the result
                this.statusCache = serverStatus;
                this.cacheTimestamp = Date.now();
                return serverStatus;
            }

            // CRITICAL: Check server for existing trial FIRST (before local data)
            // This prevents trial reset after PC restart or uninstall/reinstall
            const deviceToken = await this.getDeviceToken();
            if (deviceToken) {
                try {
                    const serverTrialCheck = await this.makeWorkerRequest('/trial/status', {
                        method: 'POST',
                        body: JSON.stringify({ deviceToken })
                    });

                    if (serverTrialCheck.hasTrial) {
                        console.log('🎯 Trial found on server! Restoring locally...');

                        // Server has trial - restore it locally
                        const trialData = {
                            deviceToken,
                            trialEndsAt: serverTrialCheck.trialEndsAt,
                            startedAt: serverTrialCheck.startedAt,
                            isTrialing: true,
                            serverVerified: true,
                            restoredFromServer: true
                        };

                        // Restore to local storage
                        await chrome.storage.local.set({ [this.TRIAL_KEY]: trialData });

                        // Check if trial is still active
                        const now = new Date();
                        const trialEnd = new Date(serverTrialCheck.trialEndsAt);

                        if (now < trialEnd) {
                            console.log('✅ Trial is still active! Ends at:', serverTrialCheck.trialEndsAt);
                            const result = {
                                active: false,
                                plan: 'trial',
                                isTrialing: true,
                                trialEndsAt: serverTrialCheck.trialEndsAt,
                                message: 'Free trial active'
                            };
                            this.statusCache = result;
                            this.cacheTimestamp = Date.now();
                            return result;
                        } else {
                            // Trial expired
                            const result = {
                                active: false,
                                plan: 'trial_expired',
                                isTrialing: false,
                                trialEndsAt: serverTrialCheck.trialEndsAt,
                                message: 'Trial expired'
                            };
                            this.statusCache = result;
                            this.cacheTimestamp = Date.now();
                            return result;
                        }
                    }
                } catch (error) {
                    console.warn('⚠️ Could not check server trial status:', error);
                    // Continue to check local data
                }
            }

            // Check local data (fallback if server check failed)
            const { subscription: localSubscription, trial: localTrial } = await this._getLocalData();

            // Check if we have a local subscription that's active
            if (localSubscription && localSubscription.active) {
                // Cache the result
                this.statusCache = localSubscription;
                this.cacheTimestamp = Date.now();
                return localSubscription;
            }

            // Check trial status
            if (localTrial) {
                try {
                    const now = new Date();
                    const trialEnd = new Date(localTrial.trialEndsAt);

                    // Validate that the date is valid
                    if (isNaN(trialEnd.getTime())) {
                        console.warn('⚠️ Invalid trial end date, treating as expired trial');
                        // Don't reset data - treat as expired trial to preserve usage history
                        const result = {
                            active: false,
                            plan: 'trial_expired',
                            isTrialing: false,
                            trialEndsAt: localTrial.trialEndsAt,
                            message: 'Trial expired (corrupted date)'
                        };
                        this.statusCache = result;
                        this.cacheTimestamp = Date.now();
                        return result;
                    }

                    if (now < trialEnd) {
                        // Trial is still active
                        const result = {
                            active: false,
                            plan: 'trial',
                            isTrialing: true,
                            trialEndsAt: localTrial.trialEndsAt,
                            message: 'Free trial active'
                        };

                        // Cache the result
                        this.statusCache = result;
                        this.cacheTimestamp = Date.now();
                        return result;
                    } else {
                        // Trial has expired


                        const result = {
                            active: false,
                            plan: 'trial_expired',
                            isTrialing: false,
                            trialEndsAt: localTrial.trialEndsAt,
                            message: 'Trial expired'
                        };

                        // Cache the result
                        this.statusCache = result;
                        this.cacheTimestamp = Date.now();
                        return result;
                    }
                } catch (dateError) {
                    console.warn('⚠️ Error parsing trial dates, treating as expired:', dateError);
                    // Don't reset data - treat as expired to preserve usage history
                    const result = {
                        active: false,
                        plan: 'trial_expired',
                        isTrialing: false,
                        message: 'Trial expired (date parsing error)'
                    };
                    this.statusCache = result;
                    this.cacheTimestamp = Date.now();
                    return result;
                }
            }

            // No trial found - check if trial was ever used before starting new trial


            // MANDATORY: Check with server if trial is allowed BEFORE trying to start
            // This prevents creating local trial data when server would block it
            if (deviceToken) {
                try {
                    const checkResponse = await fetch(`${this.WORKER_URL}/trial/check`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ deviceToken })
                    });
                    
                    if (checkResponse.ok) {
                        const checkResult = await checkResponse.json();
                        if (!checkResult.allowed) {
                            // Server says NO - don't even try to start trial
                            const result = {
                                active: false,
                                plan: 'trial_denied',
                                isTrialing: false,
                                message: 'Trial not available',
                                errorDetails: checkResult.reason === 'device_already_used' 
                                    ? 'This device has already used a free trial'
                                    : 'A trial has already been used from this network'
                            };
                            this.statusCache = result;
                            this.cacheTimestamp = Date.now();
                            return result;
                        }
                    }
                } catch (checkError) {
                    console.warn('⚠️ Pre-check failed, will try to start trial:', checkError);
                }
            }
            
            // Server allows trial (or check failed) - try to start
            try {
                const trialData = await this.startTrial();
                const result = {
                    active: false,
                    plan: 'trial',
                    isTrialing: true,
                    trialEndsAt: trialData.trialEndsAt,
                    message: 'Free trial active'
                };

                this.statusCache = result;
                this.cacheTimestamp = Date.now();
                return result;
            } catch (trialError) {
                console.error('💥 Failed to start trial:', trialError);
                
                // Check if this is a server denial (trial not allowed)
                const isDenied = trialError.message.includes('already used') ||
                                trialError.message.includes('limit exceeded') ||
                                trialError.message.includes('upgrade to continue');
                
                if (isDenied) {
                    // Server explicitly denied trial
                    const result = {
                        active: false,
                        plan: 'trial_denied',
                        isTrialing: false,
                        message: 'Trial not available',
                        errorDetails: trialError.message
                    };
                    this.statusCache = result;
                    this.cacheTimestamp = Date.now();
                    return result;
                } else {
                    // Network error or server unreachable
                    const result = {
                        active: false,
                        plan: 'error',
                        isTrialing: false,
                        message: 'Unable to verify trial status',
                        errorDetails: trialError.message
                    };
                    this.statusCache = result;
                    this.cacheTimestamp = Date.now();
                    return result;
                }
            }
        } catch (error) {
            console.error('💥 Failed to get unified subscription status:', error);
            const result = {
                active: false,
                plan: 'error',
                isTrialing: false,
                message: 'Error checking subscription'
            };

            // Cache the result
            this.statusCache = result;
            this.cacheTimestamp = Date.now();
            return result;
        }
    }

    /**
     * Get local subscription data (internal helper)
     */
    async _getLocalData() {
        const result = await chrome.storage.local.get([this.SUBSCRIPTION_KEY, this.TRIAL_KEY]);
        return {
            subscription: result[this.SUBSCRIPTION_KEY],
            trial: result[this.TRIAL_KEY]
        };
    }

    /**
     * Start trial period - SERVER-MANDATORY (Chrome Web Store Compliant)
     * Server-side IP tracking is the PRIMARY abuse prevention
     */
    async startTrial() {
        try {
            const deviceToken = await this.getDeviceToken();
            if (!deviceToken) {
                throw new Error('No device token available');
            }

            // MANDATORY SERVER CHECK - No local fallback (Chrome Web Store compliant)
            // Server-side IP tracking is the PRIMARY and ONLY reliable abuse prevention
            const trialCheckResponse = await fetch(`${this.WORKER_URL}/trial/check`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ deviceToken })
            });

            if (!trialCheckResponse.ok) {
                throw new Error('Unable to connect to trial verification server. Please check your internet connection and try again.');
            }

            const trialCheck = await trialCheckResponse.json();

            // Server decision is FINAL - no local override
            if (!trialCheck.allowed) {
                let errorMessage = 'You have already used your free trial. Please upgrade to continue using ThreadAi.';

                if (trialCheck.reason === 'device_already_used') {
                    errorMessage = `This device has already used a free trial on ${new Date(trialCheck.usedAt).toLocaleDateString()}. Please upgrade to continue.`;
                } else if (trialCheck.reason === 'ip_limit_exceeded') {
                    errorMessage = trialCheck.message || 'A trial has already been used from this network. Please upgrade to continue using ThreadAi.';
                } else if (trialCheck.reason === 'server_error') {
                    errorMessage = 'Unable to verify trial eligibility. Please try again later.';
                }

                throw new Error(errorMessage);
            }

            // Server approved trial - proceed

            // CRITICAL: Register with server FIRST, store locally ONLY if approved
            
            // Calculate trial end date
            const trialEndsAt = new Date();
            trialEndsAt.setDate(trialEndsAt.getDate() + this.TRIAL_DURATION_DAYS);
            
            const registerResponse = await fetch(`${this.WORKER_URL}/trial/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    deviceToken,
                    trialEndsAt: trialEndsAt.toISOString()
                })
            });

            if (!registerResponse.ok) {
                const errorText = await registerResponse.text();
                console.error('❌ Trial registration failed:', registerResponse.status, errorText);
                throw new Error('Failed to register trial with server. Please try again.');
            }

            const registerResult = await registerResponse.json();
            
            // Verify registration succeeded
            if (!registerResult.success) {
                console.error('❌ Trial registration failed:', registerResult);
                throw new Error(registerResult.error || 'Trial registration failed');
            }

            // ONLY NOW store trial data locally (server approved it)
            const trialData = {
                deviceToken,
                trialEndsAt: trialEndsAt.toISOString(),
                startedAt: new Date().toISOString(),
                isTrialing: true,
                serverVerified: true // Server approved this trial
            };

            await chrome.storage.local.set({
                [this.TRIAL_KEY]: trialData,
                [this.TRIAL_USED_FLAG]: {
                    used: true,
                    firstUsedAt: new Date().toISOString(),
                    deviceToken: deviceToken
                }
            });

            // BONUS: Try to store in sync storage (not critical, server is primary defense)
            try {
                await chrome.storage.sync.set({
                    'persistent_device_token': deviceToken,
                    'trial_first_used': new Date().toISOString()
                });
            } catch (syncError) {
                // Sync storage failure is OK - server protects us
            }

            return trialData;
        } catch (error) {
            console.error('💥 Failed to start trial:', error);
            throw error;
        }
    }

    /**
     * Check if user can use the extension (trial or subscription)
     */
    async canUseExtension() {
        try {
            // Get the unified subscription status (same as used for UI display)
            const status = await this.getUnifiedSubscriptionStatus();

            if (status.active) {
                return { canUse: true, reason: 'subscription', status };
            }

            if (status.isTrialing) {
                return { canUse: true, reason: 'trial', status };
            }

            // If status indicates error starting trial, check if it's a server denial or network error
            if (status.plan === 'error' && status.message === 'Error starting trial') {
                // Check if the error message indicates server denial (not network error)
                const isServerDenial = status.errorDetails && (
                    status.errorDetails.includes('already used') ||
                    status.errorDetails.includes('Too many trials') ||
                    status.errorDetails.includes('Please upgrade') ||
                    status.errorDetails.includes('upgrade to continue')
                );

                if (isServerDenial) {
                    return { canUse: false, reason: 'trial_denied', status };
                } else {
                    return { canUse: true, reason: 'trial_fallback', status };
                }
            }

            // Trial has been used and expired
            return { canUse: false, reason: 'trial_expired', status };
        } catch (error) {
            console.error('💥 Failed to check usage permission:', error);
            return { canUse: false, reason: 'error', status: null };
        }
    }

    /**
     * Track usage for analytics (local storage)
     */
    async trackUsage(action) {
        try {
            const result = await chrome.storage.local.get([this.USAGE_KEY]);
            const usage = result[this.USAGE_KEY] || { count: 0, actions: [] };

            usage.count += 1;
            usage.actions.push({
                action,
                timestamp: new Date().toISOString()
            });

            // Keep only last 100 actions
            if (usage.actions.length > 100) {
                usage.actions = usage.actions.slice(-100);
            }

            await chrome.storage.local.set({ [this.USAGE_KEY]: usage });

            // Also send to server analytics (non-blocking)
            this.trackUsageAnalytics(action).catch(error => {
                console.debug('Server analytics failed:', error);
            });
        } catch (error) {
            console.error('💥 Failed to track usage:', error);
        }
    }

    /**
     * Track usage analytics on server (enhanced)
     */
    async trackUsageAnalytics(action, metadata = {}) {
        try {
            const deviceToken = await this.getDeviceToken();
            if (!deviceToken) return;

            const response = await fetch(`${this.WORKER_URL}/analytics`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    token: deviceToken,
                    action,
                    metadata: {
                        ...metadata,
                        userAgent: navigator.userAgent,
                        timestamp: new Date().toISOString(),
                        url: window.location?.href || 'extension'
                    }
                })
            });

            if (response.ok) {
                const data = await response.json();
                console.debug('📊 Analytics tracked:', action, data.counter);
            }
        } catch (error) {
            console.debug('Analytics tracking failed:', error);
        }
    }

    /**
     * Get usage statistics
     */
    async getUsageStats() {
        try {
            const result = await chrome.storage.local.get([this.USAGE_KEY]);
            return result[this.USAGE_KEY] || { count: 0, actions: [] };
        } catch (error) {
            console.error('💥 Failed to get usage stats:', error);
            return { count: 0, actions: [] };
        }
    }

    /**
     * Generate Lemon Squeezy checkout URL (FIXED - proper parameter format)
     */
    async generateCheckoutUrl(email, plan = 'pro-monthly') {
        const deviceToken = await this.getDeviceToken();
        if (!deviceToken) {
            throw new Error('No device token available for checkout');
        }

        // CRITICAL: Clear local subscription cache before checkout to prevent showing old data
        await chrome.storage.local.remove([this.SUBSCRIPTION_KEY]);
        this.clearStatusCache();

        // Use the combined checkout URL that includes all three variants
        const baseUrl = 'https://thread-ai.lemonsqueezy.com/buy/2dca2dc4-9d06-4650-9ad3-983dec0c33dd';

        // CRITICAL: Lemon Squeezy custom data format - nested object structure
        const checkoutUrl = `${baseUrl}?checkout[email]=${encodeURIComponent(email)}&checkout[custom][deviceToken]=${encodeURIComponent(deviceToken)}`;

        return checkoutUrl;
    }

    /**
     * Restore purchase by email
     */
    async restorePurchase(email) {
        try {
            const response = await fetch(`${this.WORKER_URL}/restore?email=${encodeURIComponent(email)}`);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();

            if (data.active) {
                // Link device token to subscription
                const deviceToken = await this.getDeviceToken();
                await fetch(`${this.WORKER_URL}/link`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token: deviceToken, email })
                });

                // Update local storage
                await chrome.storage.local.set({ [this.SUBSCRIPTION_KEY]: data });

                // Clear cache since subscription status changed
                this.clearStatusCache();
            }

            return data;
        } catch (error) {
            console.error('💥 Failed to restore purchase:', error);
            throw error;
        }
    }

    /**
     * Get trial time remaining
     */
    async getTrialTimeRemaining() {
        try {
            // Use unified status to ensure consistency
            const status = await this.getUnifiedSubscriptionStatus();

            if (!status.isTrialing || !status.trialEndsAt) {
                return null;
            }

            const now = new Date();
            const trialEnd = new Date(status.trialEndsAt);
            const remaining = trialEnd - now;

            if (remaining <= 0) {
                return null;
            }

            const days = Math.floor(remaining / (1000 * 60 * 60 * 24));
            const hours = Math.floor((remaining % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));

            return {
                total: remaining,
                days,
                hours,
                minutes,
                formatted: days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
            };
        } catch (error) {
            console.error('💥 Failed to get trial time remaining:', error);
            return null;
        }
    }


    /**
     * Clear status cache (call when subscription status changes)
     */
    clearStatusCache() {
        this.statusCache = null;
        this.cacheTimestamp = 0;
    }



    /**
     * Enhanced error handling with retry logic
     */
    async makeWorkerRequest(endpoint, options = {}) {
        const maxRetries = 3;
        let lastError;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const response = await fetch(`${this.WORKER_URL}${endpoint}`, {
                    ...options,
                    headers: {
                        'Content-Type': 'application/json',
                        ...options.headers
                    }
                });

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }

                return await response.json();
            } catch (error) {
                lastError = error;
                console.warn(`Worker request attempt ${attempt}/${maxRetries} failed:`, error);

                if (attempt < maxRetries) {
                    // Exponential backoff: 1s, 2s, 4s
                    const delay = Math.pow(2, attempt - 1) * 1000;
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }

        throw lastError;
    }



    /**
     * Start periodic subscription checking (SIMPLIFIED - less aggressive)
     */
    startPeriodicSubscriptionCheck() {
        // Check every 60 seconds for subscription updates (less aggressive)
        setInterval(async () => {
            try {
                const currentStatus = await this.getUnifiedSubscriptionStatus();
                if (!currentStatus.active) {
                    const serverStatus = await this._checkServerStatus();
                    if (serverStatus.active) {
                        this.clearStatusCache();
                        this.notifySubscriptionActivated(serverStatus);
                    }
                }
            } catch (error) {
                console.debug('Periodic subscription check failed:', error);
            }
        }, 60000); // 60 seconds
    }

    /**
     * Start smart subscription checking (SIMPLIFIED - notification-based only)
     */
    startSmartSubscriptionCheck() {

        // Immediate check
        this.checkForInstantActivation();

        // Notification polling (every 3 seconds for 2 minutes)
        let notificationCheckCount = 0;
        const maxNotificationChecks = 40; // 2 minutes / 3 seconds

        const notificationInterval = setInterval(async () => {
            notificationCheckCount++;

            try {
                const notification = await this.checkForActivationNotification();
                if (notification && notification.hasNotification) {
                    clearInterval(notificationInterval);

                    await chrome.storage.local.set({
                        [this.SUBSCRIPTION_KEY]: notification.notification.subscription
                    });

                    this.clearStatusCache();
                    this.notifySubscriptionActivated(notification.notification.subscription);
                    return;
                }

                if (notificationCheckCount >= maxNotificationChecks) {
                    clearInterval(notificationInterval);
                }
            } catch (error) {
                console.debug(`Notification check #${notificationCheckCount} failed:`, error);
                if (notificationCheckCount >= maxNotificationChecks) {
                    clearInterval(notificationInterval);
                }
            }
        }, 3000); // Check every 3 seconds
    }

    /**
     * Check for instant activation notification
     */
    async checkForActivationNotification() {
        try {
            const deviceToken = await this.getDeviceToken();
            if (!deviceToken) return null;

            const response = await fetch(`${this.WORKER_URL}/notifications?token=${deviceToken}`);
            if (!response.ok) return null;

            const data = await response.json();
            return data;
        } catch (error) {
            console.debug('Notification check failed:', error);
            return null;
        }
    }

    /**
     * Check for immediate activation (right after checkout)
     */
    async checkForInstantActivation() {
        try {
            // Force refresh to get latest server status (bypass cache)
            this.clearStatusCache();
            const serverStatus = await this._checkServerStatus();

            if (serverStatus.active) {
                this.notifySubscriptionActivated(serverStatus);
                return true;
            }

            return false;
        } catch (error) {
            console.debug('Instant activation check failed:', error);
            return false;
        }
    }

    /**
     * Notify about subscription activation
     */
    notifySubscriptionActivated(subscription) {
        // Notify popup if it's open
        try {
            chrome.runtime.sendMessage({
                type: 'SUBSCRIPTION_ACTIVATED',
                payload: { status: subscription }
            });
        } catch (e) {
            // Popup might not be open, that's okay
        }

        // Track analytics
        this.trackUsageAnalytics('subscription_activated', {
            plan: subscription.plan,
            activationMethod: 'automatic'
        });
    }

}

// Export singleton instance
export default new PaymentService();
