// Settings Page JavaScript
import { handleUpgradeClick as sharedHandleUpgradeClick, handleRestoreClick as sharedHandleRestoreClick } from '../../src/utils/subscription-utils.js';



// Default settings
const DEFAULT_SETTINGS = {
    keyPointsStyle: 'default',
    replyMode: 'tone',
    customPrompt: '',
    replyLength: 'short',        // Changed to short for better UX
    inlineReplyLength: 'short',  // Changed to short for better UX
    processingSpeed: 'balanced',
    showInlineButtons: true
};

// DOM elements
const elements = {
    keyPointsStyle: document.getElementById('keyPointsStyle'),
    replyMode: document.getElementById('replyMode'),
    customPrompt: document.getElementById('customPrompt'),
    customPromptGroup: document.getElementById('customPromptGroup'),
    replyLength: document.getElementById('replyLength'),
    inlineReplyLength: document.getElementById('inlineReplyLength'),
    processingSpeed: document.getElementById('processingSpeed'),
    showInlineButtons: document.getElementById('showInlineButtons'),
    saveBtn: document.getElementById('saveBtn'),
    resetBtn: document.getElementById('resetBtn'),
    notification: document.getElementById('notification'),
    // New subscription elements
    subscriptionCard: document.getElementById('subscriptionCard'),
    subscriptionPremium: document.getElementById('subscriptionPremium'),
    subscriptionTrial: document.getElementById('subscriptionTrial'),
    subscriptionExpired: document.getElementById('subscriptionExpired'),
    subscriptionPlan: document.getElementById('subscriptionPlan'),
    renewalDate: document.getElementById('renewalDate'),
    trialTime: document.getElementById('trialTime'),
    cancelBtn: document.getElementById('cancelBtn'),
    manageBtn: document.getElementById('manageBtn'),
    upgradeBtn: document.getElementById('upgradeBtn'),
    restoreBtn: document.getElementById('restoreBtn'),
    upgradeBtn2: document.getElementById('upgradeBtn2'),
    restoreBtn2: document.getElementById('restoreBtn2')
};

// Load settings on page load
document.addEventListener('DOMContentLoaded', async () => {
    await loadSettings();
    attachEventListeners();
    updateCustomPromptVisibility();
    await checkSubscriptionStatus();

    // Initialize toggle visuals
    if (elements.showInlineButtons) updateToggleVisual(elements.showInlineButtons);
});

// Load settings from storage
async function loadSettings() {
    try {
        const settings = await chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS));

        // Apply settings to form elements
        Object.keys(DEFAULT_SETTINGS).forEach(key => {
            const value = settings[key] !== undefined ? settings[key] : DEFAULT_SETTINGS[key];
            const element = elements[key];

            if (element) {
                if (element.type === 'checkbox') {
                    element.checked = value;
                } else {
                    element.value = value;
                }
            }
        });


        updateCustomPromptVisibility();
    } catch (error) {
        console.error('💥 Failed to load settings:', error);
        showNotification('Failed to load settings', 'error');
    }
}

// Save settings to storage
async function saveSettings() {
    try {
        const settings = {};

        // Collect settings from form elements
        Object.keys(DEFAULT_SETTINGS).forEach(key => {
            const element = elements[key];
            if (element) {
                settings[key] = element.type === 'checkbox' ? element.checked : element.value;
            }
        });

        // Save to chrome storage
        await chrome.storage.sync.set(settings);


        showNotification('Settings saved successfully!', 'success');

        // Notify content scripts about settings change
        try {
            const tabs = await chrome.tabs.query({});
            tabs.forEach(tab => {
                chrome.tabs.sendMessage(tab.id, {
                    action: 'SETTINGS_UPDATED',
                    settings: settings
                }).catch(() => { }); // Ignore errors for tabs without content script
            });
        } catch (error) {
            console.warn('Could not notify content scripts:', error);
        }

    } catch (error) {
        console.error('💥 Failed to save settings:', error);
        showNotification('Failed to save settings', 'error');
    }
}

// Reset settings to defaults
async function resetSettings() {
    try {
        await chrome.storage.sync.set(DEFAULT_SETTINGS);
        await loadSettings(); // Reload the form

        showNotification('Settings reset to defaults', 'success');
    } catch (error) {
        console.error('💥 Failed to reset settings:', error);
        showNotification('Failed to reset settings', 'error');
    }
}

// Show notification
function showNotification(message, type = 'success') {
    const notification = elements.notification;
    notification.textContent = message;
    notification.className = `notification show ${type}`;

    setTimeout(() => {
        notification.className = 'notification hidden';
    }, 3000);
}

// Force visual update for toggle switches
function updateToggleVisual(input) {
    const slider = input.nextElementSibling;
    if (slider && slider.classList.contains('toggle-slider')) {
        if (input.checked) {
            slider.style.background = 'var(--color-primary)';
            slider.style.borderColor = 'var(--color-primary)';
        } else {
            slider.style.background = 'var(--color-surface-elevated)';
            slider.style.borderColor = 'var(--color-border)';
        }
        // Let CSS handle the knob animation with the correct translateX value
    }
}

// Update custom prompt visibility based on reply mode
function updateCustomPromptVisibility() {
    const replyMode = elements.replyMode?.value || 'tone';
    if (elements.customPromptGroup) {
        elements.customPromptGroup.style.display = replyMode === 'custom' ? 'block' : 'none';
    }
}

// Attach event listeners
function attachEventListeners() {


    // Fix toggle switches - Add click handlers to make them work visually
    const toggleSwitches = document.querySelectorAll('.toggle-switch');


    toggleSwitches.forEach((toggle) => {
        toggle.addEventListener('click', () => {
            const input = toggle.querySelector('input[type="checkbox"]');
            if (input) {
                input.checked = !input.checked;
                input.dispatchEvent(new Event('change', { bubbles: true }));

                // Force visual update
                updateToggleVisual(input);
            }
        });
    });

    elements.saveBtn.addEventListener('click', saveSettings);
    elements.resetBtn.addEventListener('click', resetSettings);

    // Subscription event handlers
    elements.upgradeBtn?.addEventListener('click', handleUpgradeClick);
    elements.restoreBtn?.addEventListener('click', handleRestoreClick);
    elements.upgradeBtn2?.addEventListener('click', handleUpgradeClick);
    elements.restoreBtn2?.addEventListener('click', handleRestoreClick);
    elements.cancelBtn?.addEventListener('click', handleCancelClick);
    elements.manageBtn?.addEventListener('click', handleManageClick);

    // Special handler for reply mode to show/hide custom prompt
    if (elements.replyMode) {
        elements.replyMode.addEventListener('change', updateCustomPromptVisibility);
    }

    // Add change listeners to update visuals
    if (elements.showInlineButtons) {
        elements.showInlineButtons.addEventListener('change', (event) => {
            updateToggleVisual(event.target);
        });
    }

    // Auto-save on change (optional - you can remove this if you prefer manual save)
    Object.keys(elements).forEach(key => {
        const element = elements[key];
        if (element && element.addEventListener &&
            key !== 'saveBtn' && key !== 'resetBtn' && key !== 'notification' && key !== 'customPromptGroup') {

            const eventType = element.tagName === 'TEXTAREA' ? 'input' : 'change';
            element.addEventListener(eventType, () => {
                // Visual feedback that settings changed
                elements.saveBtn.style.background = '#ff9500';
                elements.saveBtn.textContent = 'Save Changes';

                setTimeout(() => {
                    elements.saveBtn.style.background = '';
                    elements.saveBtn.textContent = 'Save Settings';
                }, 2000);
            });
        }
    });
}

// --- Subscription Management ---

async function checkSubscriptionStatus() {
    try {
        const response = await chrome.runtime.sendMessage({ action: 'CHECK_SUBSCRIPTION_STATUS' });
        if (response?.success) {
            updateSubscriptionUI(response.status);
        } else {
            console.warn('Failed to check subscription status:', response?.error);
            elements.subscriptionText.textContent = 'Failed to check subscription status';
        }
    } catch (error) {
        console.error('Subscription status check failed:', error);
        elements.subscriptionText.textContent = 'Error checking subscription status';
    }
}

function updateSubscriptionUI(status) {
    // Hide all subscription views first
    elements.subscriptionPremium.style.display = 'none';
    elements.subscriptionTrial.style.display = 'none';
    elements.subscriptionExpired.style.display = 'none';

    if (status.active) {
        // Premium user
        elements.subscriptionPremium.style.display = 'block';

        // Format plan name
        const planName = formatPlanName(status.plan);
        elements.subscriptionPlan.textContent = planName;

        // Format renewal date
        if (status.renewsAt) {
            const renewalDate = new Date(status.renewsAt);
            elements.renewalDate.textContent = renewalDate.toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric'
            });
        } else {
            elements.renewalDate.textContent = 'Not available';
        }

    } else if (status.isTrialing) {
        // Trial user
        elements.subscriptionTrial.style.display = 'block';

        // Get trial time remaining
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

                    elements.trialTime.textContent = timeText;
                } else {
                    elements.trialTime.textContent = 'Active';
                }
            })
            .catch(() => {
                elements.trialTime.textContent = 'Active';
            });

    } else {
        // No subscription or expired
        elements.subscriptionExpired.style.display = 'block';
    }
}

// Format plan names for display
function formatPlanName(plan) {
    const planNames = {
        'pro-monthly': 'Pro Monthly',
        'pro-quarterly': 'Pro Quarterly',
        'pro-yearly': 'Pro Yearly',
        'lifetime': 'Lifetime',
        'unknown': 'Premium Plan'
    };

    return planNames[plan] || 'Premium Plan';
}

async function handleUpgradeClick() {
    await sharedHandleUpgradeClick(showNotification, false);
}

async function handleRestoreClick() {
    await sharedHandleRestoreClick(showNotification, checkSubscriptionStatus);
}

async function handleCancelClick() {
    try {
        const confirmed = confirm(
            'Are you sure you want to cancel your subscription?\n\n' +
            'You will continue to have access until your current billing period ends, ' +
            'but your subscription will not renew.'
        );

        if (!confirmed) return;

        showNotification('Opening subscription management...', 'info');

        // Open Lemon Squeezy customer portal
        const portalUrl = 'https://thread-ai.lemonsqueezy.com/billing';
        chrome.tabs.create({ url: portalUrl });

    } catch (error) {
        console.error('Cancel error:', error);
        showNotification('Failed to open subscription management.', 'error');
    }
}

async function handleManageClick() {
    try {
        showNotification('Opening billing management...', 'info');

        // Open Lemon Squeezy customer portal
        const portalUrl = 'https://thread-ai.lemonsqueezy.com/billing';
        chrome.tabs.create({ url: portalUrl });

    } catch (error) {
        console.error('Manage billing error:', error);
        showNotification('Failed to open billing management.', 'error');
    }
}