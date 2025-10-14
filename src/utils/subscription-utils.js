// Shared subscription utility functions

export async function handleUpgradeClick(showNotification, storeCheckoutTime = false) {
    try {
        const email = prompt('Enter your email address to upgrade:');
        if (!email || !email.includes('@')) {
            showNotification('Please enter a valid email address.', 'error');
            return;
        }

        const response = await chrome.runtime.sendMessage({
            action: 'GENERATE_CHECKOUT_URL',
            payload: { email, plan: 'pro-monthly' }
        });

        if (response?.success) {
            // Store checkout timestamp for payment completion detection (popup only)
            if (storeCheckoutTime) {
                await chrome.storage.local.set({ 'lastCheckoutTime': Date.now() });
            }

            chrome.tabs.create({ url: response.url });
            const message = storeCheckoutTime
                ? 'Opening checkout page... We\'ll automatically detect when payment is complete.'
                : 'Opening checkout page...';
            showNotification(message, 'info');
        } else {
            showNotification('Failed to open checkout page.', 'error');
        }
    } catch (error) {
        console.error('Upgrade error:', error);
        showNotification('Failed to open upgrade page.', 'error');
    }
}

export async function handleRestoreClick(showNotification, checkSubscriptionStatusCallback = null) {
    try {
        const email = prompt('Enter the email address used for your purchase:');
        if (!email || !email.includes('@')) {
            showNotification('Please enter a valid email address.', 'error');
            return;
        }

        showNotification('Restoring purchase...', 'info');

        const response = await chrome.runtime.sendMessage({
            action: 'RESTORE_PURCHASE',
            payload: { email }
        });

        if (response?.success && response.result.active) {
            showNotification('Purchase restored successfully!', 'success');
            // Force refresh subscription status from server (popup only)
            if (checkSubscriptionStatusCallback) {
                await checkSubscriptionStatusCallback(true);
            }
        } else {
            showNotification('No active subscription found for this email.', 'error');
        }
    } catch (error) {
        console.error('Restore error:', error);
        showNotification('Failed to restore purchase.', 'error');
    }
}