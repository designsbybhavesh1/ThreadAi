// src/background/background.js
// Main background service worker for ThreadAi



// Safe static imports
// Inline constants
const MESSAGES = {
    STATUS: {
        PROCESSING: "🧠 Analyzing thread with Chrome AI..."
    }
};
import ChromeAIService from '../services/chrome-ai.js';
import PaymentService from '../services/payment.js';

// State management
let isProcessing = false;
let isModelDownloading = false;
let modelDownloadProgress = 0;
let downloadStartTime = null;
let currentDownloadPhase = 'downloading';
let currentDownloadMessage = null;

// Download state management
const DOWNLOAD_STATE_KEY = 'ai_model_download_state';

// Helper function to send AI ready notification
async function sendAIReadyNotification(source = 'download') {
    try {
        // Show notification
        await chrome.notifications.create('ai-ready', {
            type: 'basic',
            iconUrl: chrome.runtime.getURL('public/icons/icon128.png'),
            title: '🎉 ThreadAi is Ready!',
            message: 'AI model successfully downloaded and ready to use. Click to start summarizing threads!',
            priority: 2,
            requireInteraction: true
        });

        // Update extension badge to show ready state
        chrome.action.setBadgeText({ text: '✓' });
        chrome.action.setBadgeBackgroundColor({ color: '#10b981' });
        chrome.action.setTitle({ title: 'ThreadAi - AI Ready! Click to start summarizing.' });

        // Clear badge after 10 seconds
        setTimeout(() => {
            chrome.action.setBadgeText({ text: '' });
            chrome.action.setTitle({ title: 'ThreadAi - AI Thread Summarizer' });
        }, 10000);


    } catch (notificationError) {
        console.warn('⚠️ Could not show notification:', notificationError);
        // Fallback: try to open popup to show ready state
        if (source === 'download') {
            try {
                chrome.action.openPopup();
            } catch (popupError) {
                console.warn('⚠️ Could not open popup either:', popupError);
            }
        }
    }
}

// Initialize background script
(async function initializeBackground() {
    // Check for existing trial/subscription immediately on service worker start
    // This ensures trial restoration happens even if extension is never opened
    PaymentService.getUnifiedSubscriptionStatus(true).catch(error => {
        console.warn('Initial subscription check failed:', error);
    });

    // Restore download state if any
    const hasOngoingDownload = await loadDownloadState();
    if (hasOngoingDownload) {

    }
})();


async function saveDownloadState() {
    const state = {
        isDownloading: isModelDownloading,
        progress: modelDownloadProgress,
        phase: currentDownloadPhase,
        message: currentDownloadMessage,
        startTime: downloadStartTime,
        timestamp: Date.now(),
        modelStatus: await ChromeAIService.getAvailability()
    };
    await chrome.storage.local.set({ [DOWNLOAD_STATE_KEY]: state });
}

async function clearDownloadState() {
    await chrome.storage.local.remove([DOWNLOAD_STATE_KEY]);
}

async function loadDownloadState() {
    try {
        const result = await chrome.storage.local.get([DOWNLOAD_STATE_KEY]);
        const state = result[DOWNLOAD_STATE_KEY];

        if (state && state.isDownloading) {
            // Check if the download state is recent (within last 30 minutes)
            const now = Date.now();
            const stateAge = now - (state.timestamp || 0);
            const maxAge = 30 * 60 * 1000; // 30 minutes

            if (stateAge < maxAge) {

                isModelDownloading = state.isDownloading;
                modelDownloadProgress = state.progress || 0;
                currentDownloadPhase = state.phase || 'downloading';
                currentDownloadMessage = state.message || null;
                downloadStartTime = state.startTime || Date.now();
                return true;
            } else {

                await clearDownloadState();
            }
        }
        return false;
    } catch (error) {
        console.error('Failed to load download state:', error);
        return false;
    }
}

// Utility function to send messages with retries
async function sendMessageWithRetries(tabId, message, retries = 3, delay = 100) {
    if (!tabId) {
        throw new Error('Invalid tab ID provided');
    }

    for (let i = 0; i < retries; i++) {
        try {
            const tab = await chrome.tabs.get(tabId).catch(() => null);
            if (!tab) {
                throw new Error('Tab no longer exists');
            }

            const response = await chrome.tabs.sendMessage(tabId, message);
            if (response) {
                return response;
            }
        } catch (error) {
            if (error.message.includes('Tab no longer exists') ||
                error.message.includes('No tab with id')) {
                throw error;
            }

            if (i === retries - 1) {
                console.error(`💥 Failed to send message after ${retries} attempts:`, error.message);
                throw error;
            }
            console.warn(`⚠️ Message sending failed (attempt ${i + 1}/${retries}), retrying...`);
        }
        await new Promise(resolve => setTimeout(resolve, delay * (i + 1)));
    }
    throw new Error("Could not establish connection with the content script after multiple retries.");
}



// Main thread summarization function
async function processThreadSummarization(tab, options = {}) {
    if (!tab || !tab.id) {
        return { success: false, error: "No active tab found." };
    }

    // Validate tab URL - allow any HTTPS page for generic content extraction
    const supportedDomains = ['twitter.com', 'x.com', 'reddit.com', 'linkedin.com'];
    const isKnownPlatform = supportedDomains.some(domain => tab.url?.includes(domain));

    // Special handling for threads - show coming soon message
    if (tab.url?.includes('threads.net') || tab.url?.includes('threads.com')) {
        return { success: false, error: "ThreadAi is coming soon for threads.net! Please try on Twitter, Reddit, LinkedIn, or other websites." };
    }

    // Allow any HTTPS page, but warn for unknown platforms
    if (!tab.url?.startsWith('https://')) {
        return { success: false, error: "Only HTTPS pages are supported for security reasons." };
    }

    if (!isKnownPlatform) {

    }

    // Check subscription/trial status
    const usageCheck = await PaymentService.canUseExtension();


    if (!usageCheck.canUse) {
        let errorMessage = "Subscription required to use this feature.";

        if (usageCheck.reason === 'trial_expired') {
            errorMessage = "Your free trial has expired. Please upgrade to continue using ThreadAi.";
        } else if (usageCheck.reason === 'trial_used') {
            errorMessage = "You have already used your free trial. Please upgrade to continue using ThreadAi.";
        } else if (usageCheck.reason === 'trial_denied') {
            errorMessage = usageCheck.status?.errorDetails || "Trial access denied. Please upgrade to continue using ThreadAi.";
        } else if (usageCheck.reason === 'error') {
            errorMessage = "Unable to verify subscription status. Please try again.";
        }

        console.error('💥 Access denied:', { reason: usageCheck.reason, status: usageCheck.status });
        return { success: false, error: errorMessage, requiresUpgrade: true };
    }



    // Track usage
    await PaymentService.trackUsage('summarization');

    try {
        // 1. Ensure content script is ready (try handshake first)

        let contentScriptReady = false;

        try {
            await sendMessageWithRetries(tab.id, { action: 'PING' });
            contentScriptReady = true;

        } catch (pingError) {
            console.warn("⚠️ Content script ping failed:", pingError);
        }

        // 2. If content script not ready, inject it dynamically
        if (!contentScriptReady) {

            try {
                await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    files: ['src/content/content.js']
                });
                await chrome.scripting.insertCSS({
                    target: { tabId: tab.id },
                    files: ['src/content/content.css']
                });


                // Try handshake again after injection
                await sendMessageWithRetries(tab.id, { action: 'PING' });

            } catch (injectionError) {
                console.error("💥 Content script injection failed:", injectionError);
                throw new Error("Could not inject content script. Please refresh the page and try again.");
            }
        }

        // 3. Extract thread content

        const contentResponse = await chrome.tabs.sendMessage(tab.id, {
            action: 'EXTRACT_THREAD_CONTENT',
            payload: { focusedOnly: !!options.focusedOnly }
        });

        if (!contentResponse || !contentResponse.success) {
            throw new Error(contentResponse?.error || "Failed to extract thread content.");
        }

        const threadContent = contentResponse.data;


        // Validate content
        if (!threadContent.text || threadContent.text.trim().length < 10) {
            throw new Error("No meaningful content found on this page. Please try a different thread or post.");
        }

        // 4. Process with AI


        // Get user settings for customization
        const settings = await chrome.storage.sync.get([
            'summaryPoints', 'keyPointsStyle', 'processingSpeed'
        ]);

        const summary = await ChromeAIService.summarizeThread(threadContent, settings);

        return {
            success: true,
            data: {
                summary,
                threadContent
            }
        };
    } catch (error) {
        console.error("💥 processThreadSummarization error:", error);

        // Provide user-friendly error messages
        if (error.message.includes("Could not establish connection")) {
            return { success: false, error: "Could not connect to the page. Please refresh the tab and try again." };
        } else if (error.message.includes("Tab no longer exists")) {
            return { success: false, error: "The tab was closed. Please try again on an active tab." };
        } else if (error.message.includes("No meaningful content")) {
            return { success: false, error: error.message };
        } else if (error.message.includes("Cannot access")) {
            return { success: false, error: "Cannot access this page. Please try on a different website or refresh the page." };
        }
        return { success: false, error: error.message };
    }
}

// Context menu click handler
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === 'summarize-thread') {

        try {
            await handleContextMenuSummarization(tab);
        } catch (error) {
            console.error('💥 Context menu processing error:', error);
            chrome.notifications.create({
                type: 'basic',
                iconUrl: chrome.runtime.getURL('public/icons/icon128.png'),
                title: 'Summarization Failed',
                message: error.message || 'Could not summarize the thread.'
            });
        }
    }
});

// Context menu summarization handler
async function handleContextMenuSummarization(tab) {
    // Ensure content script is injected
    try {
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['src/content/content.js']
        });

    } catch (error) {
        // Content script might already be injected, that's okay

    }
    await chrome.storage.local.remove('contextMenuResult');

    // Check subscription/trial status
    const usageCheck = await PaymentService.canUseExtension();


    if (!usageCheck.canUse) {
        let errorMessage = "Subscription required to use this feature.";

        if (usageCheck.reason === 'trial_expired') {
            errorMessage = "Your free trial has expired. Please upgrade to continue using ThreadAi.";
        } else if (usageCheck.reason === 'trial_used') {
            errorMessage = "You have already used your free trial. Please upgrade to continue using ThreadAi.";
        } else if (usageCheck.reason === 'trial_denied') {
            errorMessage = usageCheck.status?.errorDetails || "Trial access denied. Please upgrade to continue using ThreadAi.";
        } else if (usageCheck.reason === 'error') {
            errorMessage = "Unable to verify subscription status. Please try again.";
        }

        console.error('💥 Context menu access denied:', { reason: usageCheck.reason, status: usageCheck.status });
        chrome.notifications.create({
            type: 'basic',
            iconUrl: chrome.runtime.getURL('public/icons/icon128.png'),
            title: 'ThreadAi - Upgrade Required',
            message: errorMessage
        });
        return;
    }



    // Track usage
    await PaymentService.trackUsage('context_menu_summarization');

    isProcessing = true;

    try {
        await chrome.action.openPopup();
    } catch (error) {
        chrome.windows.create({
            url: chrome.runtime.getURL('public/popup/popup.html'),
            type: 'popup',
            width: 420,
            height: 580,
            focused: true
        });
    }

    await new Promise(resolve => setTimeout(resolve, 100));

    try {
        chrome.runtime.sendMessage({ type: 'PROCESSING_STARTED' });
    } catch (e) {
        console.warn('Could not notify about processing start:', e);
    }

    try {
        // Real AI processing with content extraction
        const result = await processThreadSummarization(tab, { focusedOnly: true });

        if (result.success) {
            // Track usage for info button logic
            const usage = await chrome.storage.local.get(['firstTimeUsed', 'totalSummarizations']);
            await chrome.storage.local.set({
                'firstTimeUsed': true,
                'totalSummarizations': (usage.totalSummarizations || 0) + 1
            });
            chrome.runtime.sendMessage({ type: 'PROCESSING_COMPLETE', payload: result });
        } else {
            chrome.runtime.sendMessage({ type: 'PROCESSING_ERROR', payload: { error: result.error } });
            throw new Error(result.error);
        }
    } catch (error) {
        chrome.runtime.sendMessage({ type: 'PROCESSING_ERROR', payload: { error: error.message } });
        throw error;
    } finally {
        isProcessing = false;
    }
}

// Main message listener
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {


    (async () => {
        try {
            switch (request.action) {
                case 'GET_AI_AVAILABILITY':
                    let availability = await ChromeAIService.getAvailability();

                    // Check if there's an ongoing download
                    if (isModelDownloading) {
                        // If we think we're downloading but AI is available, clear the download state
                        if (availability === 'available') {

                            isModelDownloading = false;
                            await clearDownloadState();

                            // Send notification since AI is now ready
                            await sendAIReadyNotification('availability-check');
                        } else {
                            availability = 'downloading';
                        }
                    }

                    if (availability === 'available') {
                        ChromeAIService.quickCheck().catch(() => { });
                    }
                    sendResponse({ success: true, availability });
                    break;



                case 'GET_PROCESSING_STATE':
                    sendResponse({ success: true, processing: isProcessing });
                    break;

                case 'GET_CONTEXT_RESULT':
                    // Always return no cached result to force fresh extraction
                    sendResponse({ success: false, error: 'No cached result - will extract fresh content.' });
                    break;

                case 'START_PROCESSING':
                    if (isProcessing) {
                        sendResponse({ success: false, error: "Processing already in progress. Please wait." });
                        return;
                    }

                    isProcessing = true;
                    sendResponse({ success: true, status: MESSAGES.STATUS.PROCESSING });

                    try {
                        // Real AI processing
                        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
                        const activeTab = tabs?.[0];
                        const result = await processThreadSummarization(activeTab);

                        if (result.success) {
                            // Track usage for info button logic
                            const usage = await chrome.storage.local.get(['firstTimeUsed', 'totalSummarizations']);
                            await chrome.storage.local.set({
                                'firstTimeUsed': true,
                                'totalSummarizations': (usage.totalSummarizations || 0) + 1
                            });
                            chrome.runtime.sendMessage({ type: 'PROCESSING_COMPLETE', payload: result });
                        } else {
                            chrome.runtime.sendMessage({ type: 'PROCESSING_ERROR', payload: { error: result.error } });
                        }
                        isProcessing = false;
                    } catch (error) {
                        chrome.runtime.sendMessage({
                            type: 'PROCESSING_ERROR',
                            payload: { error: error.message }
                        });
                        isProcessing = false;
                    }
                    break;



                case 'GENERATE_REPLY':
                    try {
                        const { threadContent, summary, tone, replyLength, customPrompt } = request.payload;

                        // Get user settings for reply generation
                        const settings = await chrome.storage.sync.get(['replyLength', 'replyMode', 'customPrompt']);

                        // Use custom prompt from payload if provided, otherwise check settings
                        const useCustomPrompt = customPrompt || (settings.replyMode === 'custom' && settings.customPrompt?.trim());
                        const finalCustomPrompt = customPrompt || (useCustomPrompt ? settings.customPrompt : null);

                        // For custom prompts, don't use reply length settings
                        const effectiveLength = useCustomPrompt ? 'custom' : (replyLength || settings.replyLength || 'short');

                        const reply = await ChromeAIService.generateReply(
                            threadContent,
                            summary,
                            tone,
                            effectiveLength,
                            finalCustomPrompt
                        );
                        sendResponse({ success: true, reply });
                    } catch (error) {
                        sendResponse({ success: false, error: error.message });
                    }
                    break;

                case 'INITIATE_MODEL_DOWNLOAD':
                    if (isModelDownloading) {
                        sendResponse({ success: false, error: "Download already in progress." });
                        return;
                    }

                    isModelDownloading = true;
                    modelDownloadProgress = 0;
                    downloadStartTime = Date.now();
                    await saveDownloadState();

                    sendResponse({ success: true });

                    const progressCallback = async (progress, phase = 'downloading', message = null) => {
                        modelDownloadProgress = Math.min(progress, 100);
                        currentDownloadPhase = phase;
                        currentDownloadMessage = message;
                        await saveDownloadState();
                        chrome.runtime.sendMessage({
                            type: 'DOWNLOAD_PROGRESS',
                            payload: {
                                progress: modelDownloadProgress,
                                phase: phase,
                                message: message
                            }
                        });
                    };

                    ChromeAIService.downloadModelWithProgress(progressCallback)
                        .then(async (session) => {
                            isModelDownloading = false;
                            modelDownloadProgress = 100;
                            await clearDownloadState();

                            // Send completion message to popup
                            chrome.runtime.sendMessage({
                                type: 'DOWNLOAD_COMPLETE',
                                payload: { phase: 'ready' }
                            });

                            // Show notification when AI is fully ready
                            await sendAIReadyNotification('download');
                        })
                        .catch(async (error) => {
                            isModelDownloading = false;
                            await clearDownloadState();
                            chrome.runtime.sendMessage({
                                type: 'DOWNLOAD_ERROR',
                                payload: { error: error.message }
                            });
                        });
                    break;

                case 'GET_DOWNLOAD_PROGRESS':
                    // Double-check if we should still be in downloading state
                    if (isModelDownloading) {
                        const availability = await ChromeAIService.getAvailability();
                        if (availability === 'available') {

                            isModelDownloading = false;
                            await clearDownloadState();

                            // Send notification since AI is now ready
                            await sendAIReadyNotification('progress-check');
                        }
                    }

                    sendResponse({
                        success: true,
                        progress: modelDownloadProgress,
                        phase: currentDownloadPhase,
                        message: currentDownloadMessage,
                        isDownloading: isModelDownloading
                    });
                    break;



                case 'CHECK_SUBSCRIPTION_STATUS':
                    try {
                        const status = await PaymentService.getUnifiedSubscriptionStatus();
                        sendResponse({ success: true, status });
                    } catch (error) {
                        sendResponse({ success: false, error: error.message });
                    }
                    break;

                case 'GET_TRIAL_TIME_REMAINING':
                    try {
                        const timeRemaining = await PaymentService.getTrialTimeRemaining();
                        sendResponse({ success: true, timeRemaining });
                    } catch (error) {
                        sendResponse({ success: false, error: error.message });
                    }
                    break;

                case 'RESTORE_PURCHASE':
                    try {
                        const { email } = request.payload;
                        const result = await PaymentService.restorePurchase(email);
                        sendResponse({ success: true, result });
                    } catch (error) {
                        sendResponse({ success: false, error: error.message });
                    }
                    break;

                case 'GENERATE_CHECKOUT_URL':
                    try {
                        const { email, plan } = request.payload;
                        const url = await PaymentService.generateCheckoutUrl(email, plan);

                        // Start smart subscription checking with real-time notifications
                        PaymentService.startSmartSubscriptionCheck();

                        sendResponse({ success: true, url });
                    } catch (error) {
                        sendResponse({ success: false, error: error.message });
                    }
                    break;

                case 'GET_USAGE_STATS':
                    try {
                        const stats = await PaymentService.getUsageStats();
                        sendResponse({ success: true, stats });
                    } catch (error) {
                        sendResponse({ success: false, error: error.message });
                    }
                    break;

                case 'REFRESH_SUBSCRIPTION_STATUS':
                    try {
                        // Force refresh from server
                        const status = await PaymentService.getUnifiedSubscriptionStatus(true);
                        sendResponse({ success: true, status });
                    } catch (error) {
                        sendResponse({ success: false, error: error.message });
                    }
                    break;

                case 'CHECK_PAYMENT_COMPLETION':
                    try {
                        // This is called when user returns from payment page


                        // Force immediate server check
                        const serverStatus = await PaymentService.getUnifiedSubscriptionStatus(true);

                        if (serverStatus.active) {

                            // Start smart checking with real-time notifications
                            PaymentService.startSmartSubscriptionCheck();
                        }
                        // REMOVED: Don't call attemptDeviceTokenLinking() here
                        // It causes false activations when user closes checkout without paying

                        sendResponse({ success: true, status: serverStatus });
                    } catch (error) {
                        sendResponse({ success: false, error: error.message });
                    }
                    break;



                default:
                    sendResponse({ success: false, error: "Unknown action" });
            }
        } catch (error) {
            console.error("💥 Background message listener error:", error);
            sendResponse({ success: false, error: error.message });
        }
    })();

    return true;
});

// Lifecycle events
chrome.runtime.onInstalled.addListener(async (details) => {
    // Create context menu for all HTTPS pages
    chrome.contextMenus.create({
        id: 'summarize-thread',
        title: '🧠 Summarize This Thread',
        contexts: ['selection', 'page'],
        documentUrlPatterns: [
            'https://*/*'  // Works on all HTTPS pages
        ]
    });

    // Check for existing trial/subscription immediately on install/reinstall
    // This ensures trial restoration happens before user opens popup
    PaymentService.getUnifiedSubscriptionStatus(true).catch(error => {
        console.warn('Initial subscription check failed:', error);
    });

    // Start periodic subscription checking for automatic premium activation
    PaymentService.startPeriodicSubscriptionCheck();
    // Pre-initialize AI for faster first use
    preInitializeAI();
});



chrome.runtime.onStartup.addListener(async () => {
    // Check for existing trial/subscription immediately on startup
    // This ensures trial restoration happens before user opens popup
    PaymentService.getUnifiedSubscriptionStatus(true).catch(error => {
        console.warn('Initial subscription check failed:', error);
    });

    // Start periodic subscription checking for automatic premium activation
    PaymentService.startPeriodicSubscriptionCheck();
    // Immediate AI pre-initialization for faster first use
    preInitializeAI();
});

// Handle notification clicks
chrome.notifications.onClicked.addListener(async (notificationId) => {
    if (notificationId === 'ai-ready') {

        try {
            // Clear the notification
            chrome.notifications.clear(notificationId);

            // Try to open the popup
            chrome.action.openPopup();
        } catch (error) {
            console.warn('⚠️ Could not open popup from notification:', error);
            // Fallback: open extension in new tab
            const url = chrome.runtime.getURL('public/popup/popup.html');
            chrome.tabs.create({ url });
        }
    }
});

// Optimized AI pre-initialization
async function preInitializeAI() {
    try {
        const availability = await ChromeAIService.getAvailability();
        if (availability === 'available') {

            // Pre-initialize session in background
            ChromeAIService.getSession().then(() => {

            }).catch(error => {
                console.warn('Pre-initialization failed:', error);
            });
        } else {

        }
    } catch (error) {
        console.warn('Could not check AI availability:', error);
    }
}

