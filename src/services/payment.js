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

        // Cache for avoiding redundant API calls
        this.statusCache = null;
        this.cacheTimestamp = 0;
        this.CACHE_DURATION = 30000; // 30 seconds

        // Initialize device token
        this.initializeDeviceToken();
    }

    /**
     * Initialize or retrieve device token (SIMPLIFIED)
     */
    async initializeDeviceToken() {
        try {
            console.log('🔍 Initializing device token...');

            const local = await chrome.storage.local.get([this.DEVICE_TOKEN_KEY]);

            if (local[this.DEVICE_TOKEN_KEY]) {
                console.log('✅ Found existing device token:', local[this.DEVICE_TOKEN_KEY]);
                return;
            }

            // Generate new device token
            console.log('🆕 Generating new device token...');
            const deviceToken = this.generateDeviceToken();
            await chrome.storage.local.set({ [this.DEVICE_TOKEN_KEY]: deviceToken });
            console.log('🔑 Generated new device token:', deviceToken);

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
     * Get current device token
     */
    async getDeviceToken() {
        try {
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

        console.log('🔍 Checking server status for token:', deviceToken);
        
        try {
            const data = await this.makeWorkerRequest(`/check?token=${deviceToken}`);
            console.log('📊 Server response:', data);

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
                console.log('📋 Using cached subscription status');
                return this.statusCache;
            }

            // First try to get server status
            let serverStatus;
            try {
                serverStatus = await this._checkServerStatus();
                console.log('🌐 Server status:', serverStatus);
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

            // Check local data
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
                        console.warn('⚠️ Invalid trial end date, resetting data');
                        await this.resetCorruptedData();
                        return await this.getUnifiedSubscriptionStatus(); // Recursive call after reset
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
                        console.log('⏰ Trial has expired');

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
                    console.warn('⚠️ Error parsing trial dates, resetting data:', dateError);
                    await this.resetCorruptedData();
                    return await this.getUnifiedSubscriptionStatus(); // Recursive call after reset
                }
            }

            // No trial found - start new trial
            console.log('🎉 New user detected, starting trial automatically');
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
                console.error('💥 Failed to start trial for new user:', trialError);
                const result = {
                    active: false,
                    plan: 'error',
                    isTrialing: false,
                    message: 'Error starting trial',
                    errorDetails: trialError.message // Pass the actual error message for analysis
                };

                this.statusCache = result;
                this.cacheTimestamp = Date.now();
                return result;
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
     * Start trial period (ENHANCED with server-side abuse prevention)
     */
    async startTrial() {
        try {
            const deviceToken = await this.getDeviceToken();
            if (!deviceToken) {
                throw new Error('No device token available');
            }

            // CRITICAL: Check with server if trial is allowed (policy-compliant abuse prevention)
            console.log('🔍 Checking server trial registry...');
            let serverAllowedTrial = false;
            
            try {
                const trialCheckResponse = await fetch(`${this.WORKER_URL}/trial/check`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ deviceToken })
                });

                if (trialCheckResponse.ok) {
                    const trialCheck = await trialCheckResponse.json();
                    console.log('📊 Server trial check result:', trialCheck);

                    if (!trialCheck.allowed) {
                        let errorMessage = 'You have already used your free trial. Please upgrade to continue using ThreadAi.';
                        
                        if (trialCheck.reason === 'device_already_used') {
                            errorMessage = `This device has already used a free trial on ${new Date(trialCheck.usedAt).toLocaleDateString()}. Please upgrade to continue.`;
                        } else if (trialCheck.reason === 'ip_limit_exceeded') {
                            errorMessage = trialCheck.message || 'Too many trials from this network. Please upgrade to continue using ThreadAi.';
                        }
                        
                        console.log('🚫 Trial denied by server:', trialCheck.reason);
                        throw new Error(errorMessage);
                    } else {
                        serverAllowedTrial = true;
                        console.log('✅ Server approved trial');
                    }
                } else {
                    console.warn('⚠️ Server trial check failed, proceeding with local trial');
                }
            } catch (error) {
                // Check if this is a trial denial error (not a network/server error)
                const isTrialDenied = error.message.includes('already used') || 
                                    error.message.includes('Too many trials') ||
                                    error.message.includes('Please upgrade') ||
                                    error.message.includes('upgrade to continue');
                
                if (isTrialDenied) {
                    console.log('🚫 Trial definitively denied by server, blocking local trial');
                    throw error; // Re-throw all trial denial errors - do NOT proceed locally
                }
                
                // Only proceed locally for actual network/server errors
                console.warn('⚠️ Server trial check network error, proceeding locally:', error);
            }

            const trialEndsAt = new Date();
            trialEndsAt.setDate(trialEndsAt.getDate() + this.TRIAL_DURATION_DAYS);

            const trialData = {
                deviceToken,
                trialEndsAt: trialEndsAt.toISOString(),
                startedAt: new Date().toISOString(),
                isTrialing: true,
                serverProtected: true // Track that server-side protection is active
            };

            // Register trial with server (only if server approved it)
            if (serverAllowedTrial) {
                try {
                    const registerResponse = await fetch(`${this.WORKER_URL}/trial/register`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            deviceToken,
                            trialEndsAt: trialData.trialEndsAt
                        })
                    });

                    if (registerResponse.ok) {
                        console.log('✅ Trial registered with server for abuse prevention');
                    } else {
                        console.warn('⚠️ Failed to register trial with server, but proceeding locally');
                    }
                } catch (error) {
                    console.warn('⚠️ Failed to register trial with server:', error);
                }
            } else {
                console.log('ℹ️ Skipping server registration (local-only trial due to server unavailability)');
            }

            // Store trial data locally
            await chrome.storage.local.set({ [this.TRIAL_KEY]: trialData });

            console.log('🎉 Trial started with server-side protection:', trialData);
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

            console.log('🔍 Unified subscription status for access check:', status);

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
                    console.log('🚫 Trial denied by server - blocking access');
                    return { canUse: false, reason: 'trial_denied', status };
                } else {
                    console.log('⚠️ Trial start failed due to network error, allowing access for new user');
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
        console.log('🧹 Cleared old subscription data before checkout');

        // Use the combined checkout URL that includes all three variants
        const baseUrl = 'https://thread-ai.lemonsqueezy.com/buy/2dca2dc4-9d06-4650-9ad3-983dec0c33dd';

        // CRITICAL: Lemon Squeezy custom data format - nested object structure
        const checkoutUrl = `${baseUrl}?checkout[email]=${encodeURIComponent(email)}&checkout[custom][deviceToken]=${encodeURIComponent(deviceToken)}`;

        console.log('🔗 Generated checkout URL with device token:', deviceToken);
        console.log('📧 Email for checkout:', email);
        console.log('🔗 Full checkout URL:', checkoutUrl);
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
            console.log('🔄 Restore purchase result:', data);

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
        console.log('🗑️ Cleared subscription status cache');
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
     * Reset corrupted subscription data and start fresh trial if eligible
     */
    async resetCorruptedData() {
        try {
            console.log('🔄 Resetting corrupted subscription data');

            // Clear all local subscription data
            await chrome.storage.local.remove([this.SUBSCRIPTION_KEY, this.TRIAL_KEY]);

            // Check if user is eligible for a new trial
            const deviceToken = await this.getDeviceToken();
            if (deviceToken) {
                console.log('🎉 Starting fresh trial after data reset');
                await this.startTrial();
            }

            return true;
        } catch (error) {
            console.error('💥 Failed to reset corrupted data:', error);
            return false;
        }
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
                        console.log('🎉 Premium subscription activated!');
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
        console.log('🚀 Starting subscription checking with real-time notifications');

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
                    console.log('🎉 Instant activation via real-time notification!');
                    clearInterval(notificationInterval);

                    await chrome.storage.local.set({
                        [this.SUBSCRIPTION_KEY]: notification.notification.subscription
                    });

                    this.clearStatusCache();
                    this.notifySubscriptionActivated(notification.notification.subscription);
                    return;
                }

                if (notificationCheckCount >= maxNotificationChecks) {
                    console.log('⏹️ Stopping notification polling after 2 minutes');
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
            console.log('📢 Notification check result:', data);
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
            console.log('⚡ Checking for instant activation...');

            // Force refresh to get latest server status (bypass cache)
            this.clearStatusCache();
            const serverStatus = await this._checkServerStatus();

            if (serverStatus.active) {
                console.log('🎉 Instant activation via server check!');
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

    /**
     * Attempt to link device token to any recent purchases
     * This is a fallback for when payment completes but device token wasn't properly linked
     */
    async attemptDeviceTokenLinking() {
        try {
            const deviceToken = await this.getDeviceToken();
            if (!deviceToken) {
                return { success: false, error: 'No device token available' };
            }

            console.log('🔗 Attempting to link device token to recent purchases:', deviceToken);

            // Try to link device token to any recent purchases
            const response = await fetch(`${this.WORKER_URL}/link-recent`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    token: deviceToken,
                    timestamp: Date.now()
                })
            });

            if (!response.ok) {
                // If endpoint doesn't exist (404) or other HTTP error, fail gracefully
                console.warn(`⚠️ Link-recent endpoint not available: ${response.status} ${response.statusText}`);
                return { success: false, error: `Server endpoint not available: ${response.status}` };
            }

            // Check if response is actually JSON
            const contentType = response.headers.get('content-type');
            if (!contentType || !contentType.includes('application/json')) {
                console.warn('⚠️ Server returned non-JSON response, likely endpoint not implemented');
                return { success: false, error: 'Server endpoint not implemented' };
            }

            const data = await response.json();
            console.log('🔗 Device token linking result:', data);

            if (data.linked) {
                // Update local storage with the linked subscription
                await chrome.storage.local.set({ [this.SUBSCRIPTION_KEY]: data.subscription });
                return { success: true, subscription: data.subscription };
            }

            return { success: false, error: 'No recent purchases found to link' };
        } catch (error) {
            // Handle JSON parsing errors gracefully
            if (error.message.includes('Unexpected token') || error.message.includes('not valid JSON')) {
                console.warn('⚠️ Server returned HTML instead of JSON, endpoint likely not implemented');
                return { success: false, error: 'Server endpoint not implemented' };
            }

            console.error('💥 Failed to link device token:', error);
            return { success: false, error: error.message };
        }
    }
}

// Export singleton instance
export default new PaymentService();
