// public/popup/popup.js

/**
 * Main Popup Script for ThreadAi.
 * Handles user interactions, communicates with background, and manages UI state.
 */

import { MESSAGES } from '../../src/utils/constants.js';
import { handleUpgradeClick as sharedHandleUpgradeClick, handleRestoreClick as sharedHandleRestoreClick } from '../../src/utils/subscription-utils.js';



// --- DOM Elements Cache ---
const DOM_CACHE = {
    loadingView: null, errorView: null, emptyView: null, summaryView: null,
    downloadView: null, initializingView: null, loadingText: null, errorText: null,
    retryBtn: null, analyzeBtn: null, downloadBtn: null, keyPointsList: null,
    quotesList: null, generateReplyBtn: null, copySummaryBtn: null,
    replySection: null, replyContent: null, copyReplyBtn: null,
    statusBadge: null, toneSelector: null,
    settingsBtn: null, infoBtn: null, infoModal: null, infoModalClose: null,
    // New elements for download progress
    downloadInfoText: null, progressContainer: null, progressBar: null,
    progressText: null, downloadNote: null, downloadInfoBanner: null,
    // Subscription elements
    subscriptionStatus: null, subscriptionBadge: null, subscriptionText: null,
    subscriptionActions: null, upgradeBtn: null, restoreBtn: null
};

// --- State ---
let currentSummary = null;
let currentThreadContent = null;
// The `isDownloading` state is now managed by the background script.

/**
 * Initializes the popup when the DOM is fully loaded.
 */
document.addEventListener('DOMContentLoaded', async () => {
    console.log('🎨 Popup DOM fully loaded. Initializing...');
    await initializePopup();
});

async function initializePopup() {
    try {
        cacheDomElements();
        attachEventListeners();
        
        // Check if user might be returning from payment
        await checkForPaymentCompletion();
        
        // If a processing is already ongoing (e.g., via right-click), show loading first
        try {
            const ps = await chrome.runtime.sendMessage({ action: 'GET_PROCESSING_STATE' });
            if (ps?.success && ps.processing) {
                showLoadingMessage(MESSAGES.STATUS.PROCESSING);
            }
        } catch {}
        // Always start fresh - no cached results
        await checkAiAvailability();
        await checkSubscriptionStatus();
    } catch (error) {
        console.error("💥 Popup initialization error:", error);
        showErrorMessage("Could not initialize the extension.", true);
    }
}

async function checkForPaymentCompletion() {
    try {
        // Check if user might be returning from payment by looking at recent checkout activity
        const lastCheckout = await chrome.storage.local.get(['lastCheckoutTime']);
        const now = Date.now();
        const fiveMinutesAgo = now - (5 * 60 * 1000);
        
        if (lastCheckout.lastCheckoutTime && lastCheckout.lastCheckoutTime > fiveMinutesAgo) {
            console.log('🔍 User might be returning from payment, checking status...');
            
            // Check for payment completion
            const response = await chrome.runtime.sendMessage({ action: 'CHECK_PAYMENT_COMPLETION' });
            if (response?.success && response.status?.active) {
                showNotification('Payment successful! Premium features activated.', 'success');
                // Clear the checkout timestamp
                await chrome.storage.local.remove(['lastCheckoutTime']);
            }
        }
    } catch (error) {
        console.debug('Payment completion check failed:', error);
    }
}

// Removed checkForContextMenuResult - always extract fresh content

async function checkAiAvailability() {
    updateStatusBadge('checking', 'Checking...');
    showLoadingMessage("Checking AI status...");
    try {
        // Add timeout to prevent hanging
        const response = await Promise.race([
            chrome.runtime.sendMessage({ action: 'GET_AI_AVAILABILITY' }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
        ]);
        if (response?.success) {
            switch (response.availability) {
                case 'available':
                    updateStatusBadge('ready', 'AI Ready');
                    // Show info button for first-time users
                    showInfoButtonIfNeeded();
                    showEmptyState();
                    break;
                case 'downloadable':
                    updateStatusBadge('not-ready', 'Download Required');
                    showDownloadState();
                    break;
                case 'downloading':
                    updateStatusBadge('downloading', 'Downloading...');
                    // If a download is already in progress, show the downloading UI
                    // and then ask the background for the current progress.
                    showDownloadingState();
                    const progressResponse = await chrome.runtime.sendMessage({ action: 'GET_DOWNLOAD_PROGRESS' });
                    if (progressResponse?.success) {
                        updateDownloadProgress(progressResponse.progress, progressResponse.phase, progressResponse.message);
                        
                        // If progress is 100% but availability is not 'available', show initialization message
                        if (progressResponse.progress >= 95) {
                            updateStatusBadge('initializing', 'Initializing...');
                            DOM_CACHE.downloadNote.textContent = 'Model downloaded! Initializing... This may take a moment.';
                        }
                    }
                    break;
                default:
                    updateStatusBadge('error', 'Not Available');
                    showErrorMessage("AI is not available on this device.");
            }
        } else {
            throw new Error(response?.error || "Failed to check AI availability.");
        }
    } catch (error) {
        console.error('AI availability check failed:', error);
        updateStatusBadge('error', 'Error');
        
        if (error.message === 'Timeout') {
            showErrorMessage("Extension is starting up. Please wait a moment and try again.", true);
        } else {
            showErrorMessage("Could not check AI status. Please refresh the page and try again.", true);
        }
    }
}

function cacheDomElements() {
    for (const key in DOM_CACHE) {
        DOM_CACHE[key] = document.getElementById(key);
    }
}

/**
 * Update the AI status badge with color and text
 */
function updateStatusBadge(status, text) {
    const statusBadge = document.getElementById('statusBadge');
    if (!statusBadge) return;
    
    // Remove all status classes
    statusBadge.className = 'status-badge';
    
    // Add new status class
    statusBadge.classList.add(`status-${status}`);
    statusBadge.textContent = text;
    
    console.log(`🎨 Status badge updated: ${status} - ${text}`);
}

function attachEventListeners() {
    DOM_CACHE.analyzeBtn?.addEventListener('click', handleAnalyzeButtonClick);
    DOM_CACHE.downloadBtn?.addEventListener('click', handleDownloadClick);
    DOM_CACHE.retryBtn?.addEventListener('click', initializePopup);
    DOM_CACHE.generateReplyBtn?.addEventListener('click', handleGenerateReplyClick);
    DOM_CACHE.copySummaryBtn?.addEventListener('click', () => handleCopyClick('summary'));
    DOM_CACHE.copyReplyBtn?.addEventListener('click', () => handleCopyClick('reply'));


    DOM_CACHE.settingsBtn?.addEventListener('click', handleSettingsClick);
    DOM_CACHE.infoBtn?.addEventListener('click', handleInfoClick);
    DOM_CACHE.infoModalClose?.addEventListener('click', closeInfoModal);
    
    // Subscription event handlers
    DOM_CACHE.upgradeBtn?.addEventListener('click', handleUpgradeClick);
    DOM_CACHE.restoreBtn?.addEventListener('click', handleRestoreClick);

    chrome.runtime.onMessage.addListener(handleMessageFromBackground);
}

function handleMessageFromBackground(message) {
    if (message.type === 'PROCESSING_STARTED') {

        showLoadingMessage(MESSAGES.STATUS.PROCESSING);
    } else if (message.type === 'PROCESSING_COMPLETE') {

        hideLoadingMessage();
        const payload = message.payload?.data;
        if (!payload || !payload.summary) {
            showErrorMessage("Failed to get a valid summary.", true);
            return;
        }
        currentSummary = payload.summary;
        currentThreadContent = payload.threadContent;
        displaySummary(currentSummary);
    } else if (message.type === 'PROCESSING_ERROR') {
        console.error("💥 Background reports processing error:", message.payload.error);
        hideLoadingMessage();
        const errorMsg = message.payload.error;
        showErrorMessage(errorMsg, true);
    } else if (message.type === 'DOWNLOAD_PROGRESS') {
        showDownloadingState(); // Ensure the correct view is visible
        updateDownloadProgress(message.payload.progress, message.payload.phase, message.payload.message);
    } else if (message.type === 'DOWNLOAD_COMPLETE') {
        // The download is done, now show the initializing view.
        updateStatusBadge('initializing', 'Initializing...');
        showInitializingState();
        
        // Check availability multiple times as initialization can take a moment
        setTimeout(() => checkAiAvailability(), 1000);
        setTimeout(() => checkAiAvailability(), 3000);
        setTimeout(() => checkAiAvailability(), 5000);
    } else if (message.type === 'MODEL_READY') {
        console.log('🎉 Model is ready for use!');
        updateStatusBadge('ready', 'AI Ready');
        // Show a brief success message
        showNotification('AI Model ready! You can now analyze threads.');
        setTimeout(checkAiAvailability, 1000); // Re-check to switch to the main view
    } else if (message.type === 'DOWNLOAD_ERROR') {
        console.error("💥 Download error:", message.payload.error);
        updateStatusBadge('error', 'Download Failed');
        showErrorMessage(`Download failed: ${message.payload.error}`, true);
        resetDownloadUI();
        
        // Show retry option for download errors
        DOM_CACHE.retryBtn.textContent = 'Retry Download';
        DOM_CACHE.retryBtn.onclick = () => {
            resetDownloadUI();
            handleDownloadClick();
        };
    } else if (message.type === 'SUBSCRIPTION_ACTIVATED') {
        console.log('🎉 Premium subscription activated!');
        showNotification('Premium subscription activated! You now have unlimited access.', 'success');
        // Refresh subscription status
        checkSubscriptionStatus();
    }
}

// --- UI State Management ---
function switchView(view) {
    Object.values(DOM_CACHE).forEach(el => {
        if (el && el.classList.contains('state-view')) {
            el.style.display = 'none';
        }
    });
    if (view) view.style.display = 'flex';
}

function showLoadingMessage(message) {
    DOM_CACHE.loadingText.textContent = message;
    switchView(DOM_CACHE.loadingView);
}

function hideLoadingMessage() {
    switchView(null);
}

function showErrorMessage(message, showRetry) {
    DOM_CACHE.errorText.textContent = message;
    DOM_CACHE.retryBtn.style.display = showRetry ? 'block' : 'none';
    switchView(DOM_CACHE.errorView);
}

function showDownloadState() {
    resetDownloadUI();
    switchView(DOM_CACHE.downloadView);
}

function showDownloadingState() {
    switchView(DOM_CACHE.downloadView);
    DOM_CACHE.downloadBtn.disabled = true;
    DOM_CACHE.progressContainer.style.display = 'flex';
    DOM_CACHE.downloadNote.style.display = 'block';
    
    // Show the info banner during download
    if (DOM_CACHE.downloadInfoBanner) {
        DOM_CACHE.downloadInfoBanner.style.display = 'flex';
    }
    
    // Update download note with helpful information
    if (DOM_CACHE.downloadNote) {
        DOM_CACHE.downloadNote.textContent = 'Downloading AI model... This may take a few minutes. You can close and reopen the extension - progress will be saved.';
    }
}

function updateDownloadProgress(progress, phase = 'downloading', message = null, isComplete = false) {
    DOM_CACHE.progressBar.style.width = `${progress}%`;
    DOM_CACHE.progressText.textContent = `${progress}%`;
    
    if (isComplete || phase === 'ready') {
        DOM_CACHE.downloadBtn.textContent = 'AI Ready!';
        DOM_CACHE.downloadBtn.disabled = true;
        DOM_CACHE.downloadBtn.style.backgroundColor = '#10b981';
        DOM_CACHE.downloadNote.textContent = 'AI model is ready to use!';
        
        // Hide the info banner when download is complete
        if (DOM_CACHE.downloadInfoBanner) {
            DOM_CACHE.downloadInfoBanner.style.display = 'none';
        }
    } else {
        // Update button text based on phase
        let buttonText = '';
        switch (phase) {
            case 'preparing':
                buttonText = 'Preparing...';
                break;
            case 'testing':
                buttonText = 'Testing... 100%';
                break;
            case 'ready':
                buttonText = 'AI Ready!';
                break;
            default:
                buttonText = `Downloading... ${progress}%`;
        }
        
        DOM_CACHE.downloadBtn.textContent = buttonText;
        DOM_CACHE.downloadBtn.disabled = true;
        DOM_CACHE.downloadBtn.style.backgroundColor = phase === 'ready' ? '#10b981' : '#1a73e8';
        
        // Show appropriate message based on phase and progress
        let displayMessage = '';
        
        if (message && message.trim()) {
            // Use custom message if provided and not empty
            displayMessage = message;
        } else {
            // Use phase-based messages
            switch (phase) {
                case 'preparing':
                    displayMessage = 'Preparing to download AI model...';
                    break;
                case 'downloading':
                    if (progress <= 1) {
                        displayMessage = 'Starting download... This may take a few minutes.';
                    } else if (progress < 80) {
                        displayMessage = 'Downloading AI model... Please wait.';
                    } else {
                        displayMessage = 'Almost done... Preparing AI model.';
                    }
                    break;
                case 'finalizing':
                    displayMessage = 'Finalizing download... This may take a moment.';
                    break;
                case 'testing':
                    displayMessage = 'Testing AI model functionality...';
                    break;
                case 'ready':
                    displayMessage = 'AI model is ready to use!';
                    break;
                default:
                    displayMessage = progress <= 1 
                        ? 'Initializing download...' 
                        : 'Downloading AI model...';
            }
        }
        
        DOM_CACHE.downloadNote.textContent = displayMessage;
    }
}



function resetDownloadUI() {
    DOM_CACHE.downloadBtn.disabled = false;
    DOM_CACHE.downloadBtn.textContent = 'Download AI Model';
    DOM_CACHE.downloadBtn.style.backgroundColor = ''; // Reset to default color
    DOM_CACHE.progressContainer.style.display = 'none';
    DOM_CACHE.downloadNote.style.display = 'none';
    DOM_CACHE.progressBar.style.width = '0%';
    DOM_CACHE.progressText.textContent = '0%';
    
    // Hide the info banner when resetting
    if (DOM_CACHE.downloadInfoBanner) {
        DOM_CACHE.downloadInfoBanner.style.display = 'none';
    }
}

function showInitializingState() {
    switchView(DOM_CACHE.initializingView);
}

function showEmptyState() {
    switchView(DOM_CACHE.emptyView);
}

function displaySummary(summary) {
    if (DOM_CACHE.keyPointsList) {
        DOM_CACHE.keyPointsList.innerHTML = '';
        summary.keyPoints.forEach(point => {
            const li = document.createElement('li');
            li.textContent = point;
            DOM_CACHE.keyPointsList.appendChild(li);
        });
    }
    if (DOM_CACHE.quotesList) {
        DOM_CACHE.quotesList.innerHTML = '';
        summary.quotes.forEach(quote => {
            const li = document.createElement('li');
            li.textContent = `"${quote}"`;
            DOM_CACHE.quotesList.appendChild(li);
        });
    }
    DOM_CACHE.replySection.style.display = 'none';
    switchView(DOM_CACHE.summaryView);
}

// --- Event Handlers ---
async function handleDownloadClick() {
    // This function is now only called by a direct user click.
    showDownloadingState();
    updateDownloadProgress(0);

    // Send message to background to start the download
    const response = await chrome.runtime.sendMessage({ action: 'INITIATE_MODEL_DOWNLOAD' });
    if (!response?.success) {
        showErrorMessage(response?.error || "Failed to start download.", true);
        resetDownloadUI();
    }
}

async function handleAnalyzeButtonClick() {
    // Clear cached results to force fresh extraction
    currentSummary = null;
    currentThreadContent = null;
    
    showLoadingMessage(MESSAGES.STATUS.PROCESSING);
    try {
        const response = await chrome.runtime.sendMessage({ action: 'START_PROCESSING' });
        if (!response?.success) {
            throw new Error(response?.error || "Background failed to start processing.");
        }
    } catch (error) {
        hideLoadingMessage();
        showErrorMessage(error.message, true);
    }
}



async function handleSettingsClick() {
    try {
        // Open settings page
        await chrome.tabs.create({ 
            url: chrome.runtime.getURL('public/settings/settings.html')
        });
    } catch (e) {
        showErrorMessage('Failed to open settings page.', false);
    }
}

async function showInfoButtonIfNeeded() {
    try {
        // Info button is now always visible
        if (DOM_CACHE.infoBtn) {
            DOM_CACHE.infoBtn.style.display = 'block';
        }
        
        // Show subtle blinking dot for first-time users only
        const usage = await chrome.storage.local.get(['performanceInfoSeen', 'totalSummarizations']);
        const isFirstTime = !usage.performanceInfoSeen && (usage.totalSummarizations || 0) < 2;
        
        const infoDot = document.getElementById('infoDot');
        if (isFirstTime && infoDot) {
            infoDot.classList.add('show');
        }
    } catch (e) {
        // Always show info button
        if (DOM_CACHE.infoBtn) {
            DOM_CACHE.infoBtn.style.display = 'block';
        }
    }
}

function handleInfoClick() {
    if (DOM_CACHE.infoModal) {
        DOM_CACHE.infoModal.style.display = 'flex';
    }
}

function closeInfoModal() {
    if (DOM_CACHE.infoModal) {
        DOM_CACHE.infoModal.style.display = 'none';
    }
    
    // Mark that user has seen the info and hide the blinking dot
    chrome.storage.local.set({ 'performanceInfoSeen': true });
    
    const infoDot = document.getElementById('infoDot');
    if (infoDot) {
        infoDot.classList.remove('show');
    }
}

async function handleGenerateReplyClick() {
    if (!currentThreadContent || !currentSummary) {
        showErrorMessage("Cannot generate a reply without a summary.", true);
        return;
    }

    DOM_CACHE.generateReplyBtn.disabled = true;
    DOM_CACHE.generateReplyBtn.textContent = 'Generating...';

    const selectedTone = DOM_CACHE.toneSelector.value;

    // Get user settings for reply length
    const settings = await chrome.storage.sync.get(['replyLength']);
    const replyLength = settings.replyLength || 'short';

    try {
        const response = await chrome.runtime.sendMessage({
            action: 'GENERATE_REPLY',
            payload: {
                threadContent: currentThreadContent,
                summary: currentSummary,
                tone: selectedTone,
                replyLength: replyLength
            }
        });

        if (response?.success) {
            DOM_CACHE.replyContent.textContent = response.reply;
            DOM_CACHE.replySection.style.display = 'block';
        } else {
            throw new Error(response?.error || "Failed to generate reply.");
        }
    } catch (error) {
        showErrorMessage(error.message, true);
    } finally {
        DOM_CACHE.generateReplyBtn.disabled = false;
        DOM_CACHE.generateReplyBtn.textContent = 'Generate Reply';
    }
}

async function handleCopyClick(type) {
    let contentToCopy = "";
    if (type === 'summary') {
        const keyPointsText = Array.from(DOM_CACHE.keyPointsList.children).map(li => `- ${li.textContent}`).join('\n');
        const quotesText = Array.from(DOM_CACHE.quotesList.children).map(li => `- ${li.textContent}`).join('\n');
        contentToCopy = `Key Points:\n${keyPointsText}\n\nNotable Quotes:\n${quotesText}`;
    } else if (type === 'reply') {
        contentToCopy = DOM_CACHE.replyContent.textContent;
    }

    try {
        await navigator.clipboard.writeText(contentToCopy);
        showNotification(`${type.charAt(0).toUpperCase() + type.slice(1)} copied!`);
    } catch (error) {
        showErrorMessage("Failed to copy to clipboard.");
    }
}



function showNotification(message, type = 'success') {
    const notification = document.createElement('div');
    
    let bgColor, duration;
    switch (type) {
        case 'error':
            bgColor = '#ef4444';
            duration = 5000;
            break;
        case 'warning':
            bgColor = '#f59e0b';
            duration = 6000;
            break;
        case 'info':
            bgColor = '#3b82f6';
            duration = 4000;
            break;
        default:
            bgColor = '#10b981';
            duration = 4000;
    }
    
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: ${bgColor};
        color: white;
        padding: 12px 20px;
        border-radius: 8px;
        z-index: 10001;
        font-weight: 500;
        max-width: 320px;
        line-height: 1.4;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    `;
    notification.textContent = message;
    document.body.appendChild(notification);
    
    setTimeout(() => {
        if (document.body.contains(notification)) {
            notification.remove();
        }
    }, duration);
}

// --- Subscription Management ---

async function checkSubscriptionStatus(forceRefresh = false) {
    try {
        const action = forceRefresh ? 'REFRESH_SUBSCRIPTION_STATUS' : 'CHECK_SUBSCRIPTION_STATUS';
        const response = await chrome.runtime.sendMessage({ action });
        if (response?.success) {
            updateSubscriptionUI(response.status);
        } else {
            console.warn('Failed to check subscription status:', response?.error);
            // Show fallback status
            updateSubscriptionUI({
                active: false,
                plan: 'error',
                isTrialing: false,
                message: 'Unable to verify subscription'
            });
        }
    } catch (error) {
        console.error('Subscription status check failed:', error);
        // Show fallback status
        updateSubscriptionUI({
            active: false,
            plan: 'error',
            isTrialing: false,
            message: 'Unable to verify subscription'
        });
    }
}

function updateSubscriptionUI(status) {
    console.log('🎨 Updating subscription UI with status:', status);
    
    if (!DOM_CACHE.subscriptionStatus) {
        console.warn('⚠️ Subscription status element not found');
        return;
    }

    DOM_CACHE.subscriptionStatus.style.display = 'block';

    // Hide the badge completely as per requirements
    if (DOM_CACHE.subscriptionBadge) {
        DOM_CACHE.subscriptionBadge.style.display = 'none';
    }

    if (!DOM_CACHE.subscriptionText) {
        console.warn('⚠️ Subscription text element not found');
        return;
    }

    if (status.active) {
        // Premium user
        DOM_CACHE.subscriptionText.textContent = `Premium - ${status.plan || 'Unlimited access'}`;
        if (DOM_CACHE.subscriptionActions) {
            DOM_CACHE.subscriptionActions.style.display = 'none';
        }
    } else if (status.isTrialing) {
        // Trial user - show days remaining
        chrome.runtime.sendMessage({ action: 'GET_TRIAL_TIME_REMAINING' })
            .then(response => {
                if (response?.success && response.timeRemaining) {
                    const { days, hours, minutes } = response.timeRemaining;
                    let timeText;
                    
                    if (days > 0 && hours > 0) {
                        timeText = `${days} day${days > 1 ? 's' : ''}, ${hours} hour${hours > 1 ? 's' : ''} left`;
                    } else if (days > 0) {
                        timeText = `${days} day${days > 1 ? 's' : ''} left`;
                    } else if (hours > 0) {
                        timeText = `${hours} hour${hours > 1 ? 's' : ''} left`;
                    } else {
                        timeText = `${minutes} minute${minutes > 1 ? 's' : ''} left`;
                    }
                    
                    DOM_CACHE.subscriptionText.textContent = `Free trial - ${timeText}`;
                } else {
                    DOM_CACHE.subscriptionText.textContent = 'Free trial active';
                }
            })
            .catch(() => {
                DOM_CACHE.subscriptionText.textContent = 'Free trial active';
            });
        
        if (DOM_CACHE.subscriptionActions) {
            DOM_CACHE.subscriptionActions.style.display = 'flex';
        }
    } else {
        // No subscription or expired
        if (status.plan === 'trial_expired') {
            DOM_CACHE.subscriptionText.textContent = 'Trial expired - Upgrade to continue';
        } else if (status.plan === 'error') {
            DOM_CACHE.subscriptionText.textContent = 'Unable to verify subscription';
        } else {
            DOM_CACHE.subscriptionText.textContent = 'No subscription - Upgrade to continue';
        }
        
        if (DOM_CACHE.subscriptionActions) {
            DOM_CACHE.subscriptionActions.style.display = 'flex';
        }
    }
}

async function handleUpgradeClick() {
    await sharedHandleUpgradeClick(showNotification, true);
}

async function handleRestoreClick() {
    await sharedHandleRestoreClick(showNotification, checkSubscriptionStatus);
}








