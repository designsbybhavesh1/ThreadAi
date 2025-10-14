// src/content/content.js

/**
 * Content Script for ThreadAi.
 * Runs on matching social media pages to extract thread content.
 * Also injects a subtle UI element to indicate the extension is active.
 */

// Define minimal constants locally to avoid module imports in content scripts
const PLATFORMS = {
    TWITTER: 'twitter',
    REDDIT: 'reddit',
    LINKEDIN: 'linkedin',
    THREADS: 'threads',
    GENERIC: 'generic'
};



// --- Global State ---
let lastExtractedContent = null;
let lastExtractionTime = 0;
const FEED_CACHE_DURATION = 0;      // No caching on feeds for fresh content
const DETAIL_CACHE_DURATION = 10000; // 10s on specific thread pages
let currentFocusedElement = null;
let scrollTimeout = null;
let observer = null;

// --- Configuration ---
const PLATFORM_SELECTORS = {
    [PLATFORMS.TWITTER]: {
        tweetContainers: 'article[data-testid="tweet"], div[data-testid="cellInnerDiv"] article, article[role="article"], div[aria-label][role="article"]',
        tweetText: '[data-testid="tweetText"], div[dir="ltr"] > span, div[data-testid="tweetText"] div[dir="ltr"], div[lang]',
        focusedTweet: 'article[tabindex="0"], article:focus-within, article:hover',
        mainTweet: 'div[data-testid="primaryColumn"] article:first-of-type',
        excludeSelectors: '[data-testid="placementTracking"], [data-testid="promotedIndicator"], [aria-label*="promoted"], [data-testid="tweet"] > div > div > div:last-child > div > div[role="button"]'
    },
    [PLATFORMS.REDDIT]: {
        postContainers: '.Post, div[data-click-id="background"], div[data-testid="post-container"], div[tabindex="-1"][role="article"]',
        postTitle: 'h1, h2._eYtD2XCVieq6emjKBH3m, [data-testid="post-content"] h3',
        postBody: '.RichTextJSON-root, div[data-click-id="body"], [data-testid="post-content"] div[data-click-id="text"]',
        comments: '.Comment, div[data-test-id="comment"], div[data-testid="comment"]',
        focusedPost: 'div[data-click-id="background"]:hover, .Post:hover',
        replyFields: 'div[contenteditable="true"][data-testid*="comment"], textarea[placeholder*="comment" i], div[role="textbox"][contenteditable="true"]'
    },
    [PLATFORMS.LINKEDIN]: {
        postContainers: '.feed-shared-update-v2, div[data-id], div[data-urn]',
        postText: '.feed-shared-inline-show-more-text, .break-words span, .feed-shared-text',
        focusedPost: '.feed-shared-update-v2:hover, div[data-id]:hover',
        excludeSelectors: '.ad-banner-container, [data-test-id="ad-banner"]'
    },
    [PLATFORMS.THREADS]: {
        postContainers: 'div[data-pressable-container="true"], div[role="article"], article, [data-testid*="post"], [data-testid*="thread"], main > div, section > div',
        postText: 'span[dir="auto"], div[dir="auto"], span[style*="text"], div[style*="text"], span, p, div[class*="text"], div[dir]',
        focusedPost: 'div[data-pressable-container="true"]:hover, div[role="article"]:hover',
        excludeSelectors: '[data-ad-preview], [data-testid="sponsored"], [aria-label*="Home"], [aria-label*="Search"], [aria-label*="Like"], [aria-label*="Reply"]'
    }
};

// --- Scroll & Visibility Tracking ---

function setupScrollObserver() {
    if (observer) observer.disconnect();

    const platform = getCurrentPlatform();
    const selectors = PLATFORM_SELECTORS[platform] || {};
    const containerSelector = selectors.tweetContainers || selectors.postContainers;

    if (!containerSelector) return;

    const elements = document.querySelectorAll(containerSelector);
    if (elements.length === 0) return;

    observer = new IntersectionObserver((entries) => {
        let bestElement = null;
        let bestScore = -1;

        entries.forEach(entry => {
            if (!entry.isIntersecting) return;

            const rect = entry.target.getBoundingClientRect();
            const centerX = window.innerWidth / 2;
            const centerY = window.innerHeight / 2;

            // Distance from center of viewport
            const dx = Math.abs(rect.left + rect.width / 2 - centerX);
            const dy = Math.abs(rect.top + rect.height / 2 - centerY);
            const distanceFromCenter = Math.sqrt(dx * dx + dy * dy);

            // Prefer elements closer to center
            const score = 1000 - distanceFromCenter;

            if (score > bestScore) {
                bestScore = score;
                bestElement = entry.target;
            }
        });

        if (bestElement) {
            currentFocusedElement = bestElement;
            // console.log("🎯 New focused element set by IntersectionObserver");
        }
    }, {
        root: null,
        threshold: 0.3, // Trigger when 30% visible
        rootMargin: '0px'
    });

    elements.forEach(el => {
        if (selectors.excludeSelectors && el.querySelector(selectors.excludeSelectors)) return;
        observer.observe(el);
    });
}

function handleScroll() {
    if (scrollTimeout) clearTimeout(scrollTimeout);

    // Invalidate focused element and cache during scroll
    currentFocusedElement = null;
    lastExtractedContent = null;

    scrollTimeout = setTimeout(() => {
        setupScrollObserver();
    }, 300); // Debounce
}

window.addEventListener('scroll', handleScroll, { passive: true });

// --- Core Content Extraction Logic ---

function getCurrentPlatform() {
    const hostname = window.location.hostname.toLowerCase();
    if (hostname.includes('twitter.com') || hostname.includes('x.com')) {
        return PLATFORMS.TWITTER;
    } else if (hostname.includes('reddit.com')) {
        return PLATFORMS.REDDIT;
    } else if (hostname.includes('linkedin.com')) {
        return PLATFORMS.LINKEDIN;
    } else if (hostname.includes('threads.net') || hostname.includes('threads.com')) {
        return 'THREADS_UNSUPPORTED'; // Special case for threads
    }
    return PLATFORMS.GENERIC;
}

function getFocusedContent(platform, selectors) {
    // Force fresh detection for Threads - disable IntersectionObserver caching
    if (platform === PLATFORMS.THREADS) {

        currentFocusedElement = null; // Clear any cached element
    }

    // 1. Use IntersectionObserver-tracked element (disabled for Threads)
    if (currentFocusedElement && document.body.contains(currentFocusedElement) && platform !== PLATFORMS.THREADS) {

        return currentFocusedElement;
    }

    // 2. Fallback: Find most centered visible element
    const containerSelector = selectors.tweetContainers || selectors.postContainers;
    const allContainers = document.querySelectorAll(containerSelector);

    let mostCenteredElement = null;
    let minDistance = Infinity;
    const centerX = window.innerWidth / 2;
    const centerY = window.innerHeight / 2;

    allContainers.forEach(container => {
        if (selectors.excludeSelectors && container.querySelector(selectors.excludeSelectors)) {
            return;
        }

        const rect = container.getBoundingClientRect();
        if (rect.top > window.innerHeight || rect.bottom < 0) return; // Not visible

        const elemCenterX = rect.left + rect.width / 2;
        const elemCenterY = rect.top + rect.height / 2;

        const dx = Math.abs(elemCenterX - centerX);
        const dy = Math.abs(elemCenterY - centerY);
        const distance = dx + dy; // Manhattan distance for simplicity

        if (distance < minDistance && rect.width > 100 && rect.height > 100) {
            minDistance = distance;
            mostCenteredElement = container;
        }
    });

    if (mostCenteredElement) {
        currentFocusedElement = mostCenteredElement;
        // console.log("📍 Set new focused element by viewport center");
        return mostCenteredElement;
    }

    // 3. Fallback: First visible container
    for (let container of allContainers) {
        if (selectors.excludeSelectors && container.querySelector(selectors.excludeSelectors)) continue;
        const rect = container.getBoundingClientRect();
        if (rect.top < window.innerHeight && rect.bottom > 0) {
            currentFocusedElement = container;
            // console.log("🔽 Set focused element by first visible");
            return container;
        }
    }

    return null;
}

function extractThreadContent(focusedOnly = false) {
    const now = Date.now();
    const isDetailPage = /twitter\.com\/.+\/status\//.test(window.location.href) ||
        /reddit\.com\/r\/.+\/comments\//.test(window.location.href) ||
        /linkedin\.com\/.+\/(posts|updates)\//.test(window.location.href);
    const cacheTtl = isDetailPage ? DETAIL_CACHE_DURATION : FEED_CACHE_DURATION;

    // ONLY use cache on detail pages — disable on feeds to avoid stale summaries
    if (!focusedOnly && isDetailPage && lastExtractedContent && (now - lastExtractionTime) < cacheTtl) {

        return lastExtractedContent;
    }

    // Never cache on feed pages unless forced
    if (!isDetailPage) {
        lastExtractedContent = null;
    }

    const platform = getCurrentPlatform();


    let content = "";
    const selectors = PLATFORM_SELECTORS[platform] || {};

    try {


        if (platform === 'THREADS_UNSUPPORTED') {
            throw new Error("ThreadAi is coming soon for threads.net! Please try on Twitter, Reddit, LinkedIn, or other websites.");
        } else if (platform === PLATFORMS.TWITTER) {
            content = extractTwitterContent(selectors, { focusedOnly });
        } else if (platform === PLATFORMS.REDDIT) {
            content = extractRedditContent(selectors, { focusedOnly });
        } else if (platform === PLATFORMS.LINKEDIN) {
            content = extractLinkedInContent(selectors);
        } else {
            content = extractGenericContent({ focusedOnly });
        }



        content = sanitizeContent(content);

        if (content.length < 20) {

        }

    } catch (error) {
        console.error("💥 Error during content extraction:", error);
        content = `Error extracting content: ${error.message}. URL: ${window.location.href}`;
    }

    const result = {
        text: content,
        url: window.location.href,
        platform: platform,
        extractedAt: new Date().toISOString()
    };

    // Only cache on detail pages
    if (isDetailPage) {
        lastExtractedContent = result;
        lastExtractionTime = now;
    }

    return result;
}

// --- Platform-Specific Extraction (unchanged except minor logging) ---

function extractTwitterContent(selectors, opts = {}) {
    let content = "";
    const isStatusPage = /\/status\/\d+/.test(window.location.pathname);

    if (isStatusPage) {

        const tweetElements = document.querySelectorAll(selectors.tweetContainers);


        tweetElements.forEach((tweetElement, index) => {
            if (tweetElement.querySelector(selectors.excludeSelectors)) {

                return;
            }

            const tweetTextElements = tweetElement.querySelectorAll(selectors.tweetText);
            let tweetText = "";
            tweetTextElements.forEach(te => {
                tweetText += (te.textContent || "").trim() + " ";
            });
            tweetText = tweetText.trim();

            if (tweetText) {
                content += `${tweetText}\n\n`;

            }
        });

    } else {


        const focusedElement = getFocusedContent(PLATFORMS.TWITTER, selectors);
        if (focusedElement) {
            const tweetTextElements = focusedElement.querySelectorAll(selectors.tweetText);
            let tweetText = "";
            tweetTextElements.forEach(te => {
                tweetText += (te.textContent || "").trim() + " ";
            });
            tweetText = tweetText.trim();
            if (tweetText) {
                content = tweetText;

            }
        }

        if (!content && !opts.focusedOnly) {
            const firstFewTweets = document.querySelectorAll(selectors.tweetContainers);
            const slice = Array.from(firstFewTweets).slice(0, 3);
            slice.forEach((tweetElement, index) => {
                if (tweetElement.querySelector(selectors.excludeSelectors)) {
                    return;
                }
                const tweetTextElements = tweetElement.querySelectorAll(selectors.tweetText);
                let tweetText = "";
                tweetTextElements.forEach(te => {
                    tweetText += (te.textContent || "").trim() + " ";
                });
                tweetText = tweetText.trim();
                if (tweetText) {
                    content += `${tweetText}\n\n`;
                }
            });

        }

        if (!content && opts.focusedOnly) {
            const sel = window.getSelection && window.getSelection();
            const selText = sel ? (sel.toString() || '').trim() : '';
            if (selText && selText.length > 10) {
                content = selText;

            }
        }
    }

    return content;
}

function extractRedditContent(selectors, opts = {}) {
    let content = "";
    const isCommentsPage = window.location.pathname.includes('/comments/');

    if (isCommentsPage) {
        console.log("📘 Reddit Comments Page detected.");
        const titleElement = document.querySelector(selectors.postTitle);
        const bodyElement = document.querySelector(selectors.postBody);

        const title = titleElement ? (titleElement.textContent || "").trim() : "";
        const body = bodyElement ? (bodyElement.textContent || "").trim() : "";

        if (title) content += `Title: ${title}\n\n`;
        if (body) content += `Body: ${body}\n\n`;

        console.debug(`📜 Extracted post title (${title.length} chars) and body (${body.length} chars)`);

        const commentElements = document.querySelectorAll(selectors.comments);
        const visibleTop = Array.from(commentElements).filter(el => {
            const rect = el.getBoundingClientRect();
            return rect.top < window.innerHeight && rect.bottom > 0;
        }).slice(0, 5);
        const topComments = visibleTop.length ? visibleTop : Array.from(commentElements).slice(0, 3);
        topComments.forEach((commentElement, index) => {
            const commentBody = commentElement.querySelector('p, div[data-test-id="comment"] p') || commentElement;
            const commentText = (commentBody.textContent || "").trim();
            if (commentText.length > 15) {
                content += `Comment ${index + 1}: ${commentText}\n\n`;
            }
        });
        if (topComments.length > 0) console.debug(`💬 Extracted top ${topComments.length} comments`);

        if (!content || content.trim().length < 20) {
            console.warn('⚠️ Reddit extraction produced little content, using generic fallback.');
            content = extractGenericContent();
        }

    } else {
        console.log("🏘️ Reddit Community/Home Page detected.");

        const focusedElement = getFocusedContent(PLATFORMS.REDDIT, selectors);
        if (focusedElement) {
            const titleElement = focusedElement.querySelector(selectors.postTitle);
            const bodyElement = focusedElement.querySelector(selectors.postBody) || focusedElement.querySelector('p');

            const title = titleElement ? (titleElement.textContent || "").trim() : "";
            const body = bodyElement ? (bodyElement.textContent || "").trim() : "";

            if (title) content += `Title: ${title}\n\n`;
            if (body) content += `Preview: ${body}\n\n`;
            console.debug(`🎯 Extracted focused post (${title.length} + ${body.length} chars)`);
        } else if (!opts.focusedOnly) {
            const firstPost = document.querySelector(selectors.postContainers);
            if (firstPost) {
                const titleElement = firstPost.querySelector(selectors.postTitle);
                const bodyElement = firstPost.querySelector(selectors.postBody) || firstPost.querySelector('p');
                const title = titleElement ? (titleElement.textContent || "").trim() : "";
                const body = bodyElement ? (bodyElement.textContent || "").trim() : "";
                if (title) content += `Title: ${title}\n\n`;
                if (body) content += `Preview: ${body}\n\n`;
                console.debug(`📋 Extracted first post (${title.length} + ${body.length} chars)`);
            }
        }

        if (!content || content.trim().length < 20) {
            console.warn('⚠️ Reddit feed extraction produced little content, using generic fallback.');
            content = extractGenericContent();
        }
    }

    return content;
}

function extractLinkedInContent(selectors) {
    let content = "";
    console.log("💼 LinkedIn Page detected.");

    const postElements = document.querySelectorAll(selectors.postContainers);
    console.debug(`🔎 Found ${postElements.length} potential post containers.`);

    if (postElements.length > 0) {
        let mainPost = postElements[0];
        let maxVisible = 0;
        postElements.forEach(el => {
            const rect = el.getBoundingClientRect();
            const visible = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0)) *
                Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
            if (visible > maxVisible) { maxVisible = visible; mainPost = el; }
        });
        const textElements = mainPost.querySelectorAll(selectors.postText);

        let combinedText = "";
        textElements.forEach(te => {
            combinedText += (te.textContent || "").trim() + " ";
        });
        content = combinedText.trim();
        console.debug(`📰 Extracted main LinkedIn post (${content.length} chars)`);
    }

    if (content.length < 50) {
        console.log("🔍 Using broader LinkedIn content extraction...");
        const broadText = document.body.textContent || "";
        content = broadText.substring(0, 2000);
        console.debug(`📄 Broad LinkedIn extraction (${content.length} chars)`);
    }

    return content;
}

function extractThreadsContent(selectors, opts = {}) {
    let content = "";
    console.log("💬 Threads Page detected");

    // Check if we're on a specific thread page or feed
    const isThreadPage = window.location.pathname.includes('/post/') ||
        window.location.pathname.includes('/thread/') ||
        window.location.pathname.match(/\/t\/[^\/]+\/\d+/) || // threads.net pattern
        document.querySelector('[data-testid="thread"]');

    if (isThreadPage) {
        console.log("🧵 Individual Thread Page detected:", window.location.pathname);

        // Strategy 1: Try to get the main thread content with enhanced selectors
        const threadSelectors = [
            selectors.postContainers,
            'div[data-pressable-container="true"]',
            'div[role="article"]',
            'article',
            '[data-testid*="post"]',
            'main div[dir]', // Common pattern for thread content
            'main span[dir]'
        ];

        for (const selector of threadSelectors) {
            const containers = document.querySelectorAll(selector);
            console.log(`🔍 Trying selector "${selector}": found ${containers.length} elements`);

            if (containers.length > 0) {
                // Try to extract from the first few containers (main thread + replies)
                let threadContent = "";
                const containersToCheck = Math.min(containers.length, 3); // Main post + first 2 replies

                for (let i = 0; i < containersToCheck; i++) {
                    const container = containers[i];
                    const textElements = container.querySelectorAll(selectors.postText + ', span[dir="auto"], div[dir="auto"], span, p');

                    let containerText = "";
                    textElements.forEach(te => {
                        const text = (te.textContent || "").trim();
                        if (text && text.length > 10 && !isUIElement(text)) {
                            containerText += text + " ";
                        }
                    });

                    if (containerText.trim()) {
                        threadContent += (i === 0 ? "Main post: " : `Reply ${i}: `) + containerText.trim() + "\n\n";
                    }
                }

                if (threadContent.trim()) {
                    content = threadContent.trim();
                    console.log(`✅ Extracted thread content using "${selector}" (${content.length} chars)`);
                    return content;
                }
            }
        }

        console.log("⚠️ No thread content found with specific selectors, trying fallback...");

        // Strategy 2: Fallback to generic extraction for thread pages
        content = extractGenericContent({ focusedOnly: false });
        if (content && content.length > 50) {
            console.log(`✅ Thread page fallback extraction successful (${content.length} chars)`);
            return content;
        }
    } else {
        console.log("🏠 Threads Feed/Home Page detected.");

        // Use dynamic focused content detection like Twitter
        console.log("🔍 Attempting to get focused content for Threads feed...");
        console.log("🔍 Current scroll position:", window.scrollY);
        console.log("🔍 Viewport center:", window.innerWidth / 2, window.innerHeight / 2);

        const focusedElement = getFocusedContent(PLATFORMS.THREADS, selectors);
        console.log("🎯 Focused element found:", !!focusedElement);

        if (focusedElement) {
            const rect = focusedElement.getBoundingClientRect();
            console.log("📍 Focused element position:", {
                top: Math.round(rect.top),
                bottom: Math.round(rect.bottom),
                left: Math.round(rect.left),
                right: Math.round(rect.right)
            });
        }

        if (focusedElement) {
            const textElements = focusedElement.querySelectorAll(selectors.postText);
            console.log(`📝 Found ${textElements.length} text elements in focused post`);

            let postText = "";
            textElements.forEach((te, index) => {
                const text = (te.textContent || "").trim();
                if (text && text.length > 10 && !isUIElement(text)) {
                    postText += text + " ";
                    console.log(`Text ${index}: "${text.substring(0, 50)}..."`);
                }
            });
            postText = postText.trim();
            if (postText) {
                content = postText;
                const timestamp = new Date().toLocaleTimeString();
                const preview = postText.substring(0, 50).replace(/\s+/g, ' ');
                console.log(`✅ [${timestamp}] Extracted focused thread post (${postText.length} chars): "${preview}..."`);
                return content;
            } else {
                console.log("❌ No meaningful text found in focused element");
            }
        } else {
            console.log("❌ No focused element found, trying fallback...");
        }

        // Fallback: Get most visible posts if not focused-only
        if (!content && !opts.focusedOnly) {
            console.log("🔄 Fallback: Getting most visible posts...");
            const allPosts = document.querySelectorAll(selectors.postContainers);
            console.log(`📦 Found ${allPosts.length} total posts`);

            // Find posts that are currently visible in viewport
            const visiblePosts = Array.from(allPosts).filter(post => {
                const rect = post.getBoundingClientRect();
                const isVisible = rect.top < window.innerHeight && rect.bottom > 0;
                if (isVisible) {
                    console.log(`📍 Visible post: top=${Math.round(rect.top)}, bottom=${Math.round(rect.bottom)}`);
                }
                return isVisible;
            }).slice(0, 3); // Take first 3 visible posts

            console.log(`👁️ Found ${visiblePosts.length} visible posts`);

            visiblePosts.forEach((postElement, index) => {
                if (selectors.excludeSelectors && postElement.querySelector(selectors.excludeSelectors)) {
                    console.log(`⏭️ Skipping post ${index} (contains excluded elements)`);
                    return;
                }

                const textElements = postElement.querySelectorAll(selectors.postText);
                let postText = "";
                textElements.forEach(te => {
                    const text = (te.textContent || "").trim();
                    if (text && text.length > 10 && !isUIElement(text)) {
                        postText += text + " ";
                    }
                });
                postText = postText.trim();
                if (postText) {
                    content += `Post ${index + 1}: ${postText}\n\n`;
                    const preview = postText.substring(0, 30).replace(/\s+/g, ' ');
                    console.log(`✅ Extracted visible post ${index + 1} (${postText.length} chars): "${preview}..."`);
                }
            });
            if (content) console.log(`📋 Extracted ${visiblePosts.length} visible feed posts (${content.length} chars total)`);
        }
    }

    // Enhanced fallback strategies if no content found
    if (!content) {
        console.log("🔄 Using enhanced fallback extraction...");

        const threadsSelectors = [
            'div[data-pressable-container="true"]',
            'div[role="article"]',
            'article',
            '[data-testid*="post"]',
            '[data-testid*="thread"]'
        ];

        const textSelectors = [
            'span[dir="auto"]',
            'div[dir="auto"]',
            'span',
            'p',
            'div[class*="text"]'
        ];

        for (const containerSelector of threadsSelectors) {
            const containers = document.querySelectorAll(containerSelector);
            if (containers.length > 0) {
                for (const textSelector of textSelectors) {
                    const textElements = containers[0].querySelectorAll(textSelector);
                    if (textElements.length > 0) {
                        const texts = Array.from(textElements)
                            .map(el => el.textContent?.trim())
                            .filter(text => text && text.length > 15 && !isUIElement(text))
                            .slice(0, 5);

                        if (texts.length > 0) {
                            content = texts.join(' ');
                            console.log(`✅ Fallback SUCCESS: Found content using ${containerSelector} + ${textSelector} (${content.length} chars)`);
                            break;
                        }
                    }
                }
                if (content) break;
            }
        }
    }

    // Final fallback to generic extraction
    if (!content) {
        console.log("🔄 Final fallback to generic extraction...");
        content = extractGenericContent();
    }

    console.log(`🏁 Final Threads extraction result: ${content.length} chars`);
    return content;
}

// Helper function to identify UI elements that should be filtered out
function isUIElement(text) {
    const uiKeywords = [
        "Home", "Search", "Profile", "Following", "Followers",
        "Like", "Reply", "Share", "Repost", "Quote", "More",
        "Settings", "Notifications", "Messages", "Explore",
        "ago", "·", "Show this thread", "Show more", "Show less"
    ];

    return uiKeywords.some(keyword => text.includes(keyword)) ||
        text.length < 10 ||
        /^\d+[smhd]$/.test(text) || // Time stamps like "2h", "5m"
        /^\d+$/.test(text); // Pure numbers
}

function extractGenericContent(opts = {}) {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`🌐 [${timestamp}] Enhanced generic content extraction, scroll: ${window.scrollY}`);

    // Try to find the most relevant visible content first
    const contentSelectors = [
        'article', 'main', '[role="main"]', '.post', '.content', '.entry',
        '.thread', '.discussion', '.comment-thread', '.blog-post',
        'div[data-testid*="post"]', 'div[data-testid*="thread"]',
        'div[class*="post"]', 'div[class*="thread"]', 'div[class*="content"]'
    ];

    let content = '';

    // Strategy 1: Find the most centered visible content (like focused content)
    let bestElement = null;
    let maxScore = 0;
    const centerY = window.innerHeight / 2;

    console.log(`📍 Viewport: scroll=${window.scrollY}, center=${centerY}`);

    for (const selector of contentSelectors) {
        const elements = document.querySelectorAll(selector);
        console.log(`🔍 Checking ${elements.length} elements for selector: ${selector}`);

        for (const element of elements) {
            const rect = element.getBoundingClientRect();

            // Check if element is visible
            if (rect.top < window.innerHeight && rect.bottom > 0) {
                const visibleHeight = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
                const visibleArea = visibleHeight * rect.width;

                // Prefer elements closer to center and with more visible area
                const elementCenterY = rect.top + rect.height / 2;
                const distanceFromCenter = Math.abs(elementCenterY - centerY);
                const score = visibleArea / (1 + distanceFromCenter / 50); // More sensitive to position

                const textLength = element.textContent?.trim().length || 0;

                if (score > maxScore && textLength > 100) {
                    maxScore = score;
                    bestElement = element;
                    console.log(`🎯 New best element: score=${Math.round(score)}, textLength=${textLength}, top=${Math.round(rect.top)}, center=${Math.round(elementCenterY)}`);
                }
            }
        }

        if (bestElement) {
            content = bestElement.textContent?.trim() || '';
            const preview = content.substring(0, 50).replace(/\s+/g, ' ');
            console.log(`✅ [${timestamp}] Found focused content using ${selector} (${content.length} chars): "${preview}..."`);
            break;
        }
    }

    // Strategy 2: Get multiple visible elements if no single best element
    if (!content || content.length < 100) {
        console.log("🔄 Trying multiple visible elements...");
        for (const selector of contentSelectors) {
            const elements = document.querySelectorAll(selector);
            const visibleTexts = Array.from(elements)
                .filter(el => {
                    const rect = el.getBoundingClientRect();
                    return rect.top < window.innerHeight && rect.bottom > 0; // Visible
                })
                .map(el => el.textContent?.trim())
                .filter(text => text && text.length > 50 && !isUIElement(text))
                .slice(0, 3); // Limit to first 3 visible elements

            if (visibleTexts.length > 0) {
                content = visibleTexts.join('\n\n');
                console.log(`📄 Found content using multiple ${selector} elements (${content.length} chars)`);
                break;
            }
        }
    }

    // Strategy 3: Fallback to body text if still no content
    if (!content || content.length < 100) {
        console.log("📄 Using fallback body text extraction...");
        const bodyText = document.body ? (document.body.textContent || "") : "";
        content = bodyText
            .replace(/\s{2,}/g, ' ')
            .substring(0, 3000);
    }

    const cleanedText = content
        .replace(/\s{2,}/g, ' ')
        .trim()
        .substring(0, 4000);

    console.debug(`📄 Generic extraction completed (${cleanedText.length} chars)`);
    return cleanedText;
}

function sanitizeContent(rawContent) {
    if (!rawContent) return "";
    return rawContent
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 5000);
}

// --- Communication with Background Script ---



chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.debug("📥 Content script received message:", request.action);

    if (request.action === 'PING') {
        console.log("🏓 PONG");
        sendResponse({ success: true, message: 'PONG' });
        return true;
    }

    if (request.action === 'EXTRACT_THREAD_CONTENT') {
        try {
            console.log("📤 Extracting thread content...");
            const content = extractThreadContent(request.payload?.focusedOnly);
            console.log("✅ Content extracted successfully (length: ", content.text.length, ")");
            sendResponse({ success: true, data: content });
        } catch (error) {
            console.error("💥 Content extraction failed:", error);
            sendResponse({ success: false, error: `Failed to extract content: ${error.message}` });
        }
        return true;
    }



    sendResponse({ success: false, error: "Unknown action for content script." });
    return true;
});

console.log('📄 ThreadAi Content Script initialized.');

// --- Inject Inline Reply Icons (unchanged) ---
(function injectInlineReplyIcons() {
    try {
        const createIcon = () => {
            const span = document.createElement('span');
            span.textContent = '✨';
            span.title = 'Generate reply with AI';
            span.style.cursor = 'pointer';
            span.style.marginLeft = '8px';
            span.style.userSelect = 'none';
            span.setAttribute('data-tsp-icon', '');
            return span;
        };
        const createSpinner = () => {
            const spinner = document.createElement('span');
            spinner.setAttribute('data-tsp-spinner', '');
            return spinner;
        };

        const generateForField = async (field, icon) => {
            try {
                // Prevent multiple simultaneous generations with visual feedback
                if (icon.dataset.processing === 'true') {
                    console.log('⚠️ Already processing, ignoring click');
                    return;
                }

                // Set processing state immediately
                icon.dataset.processing = 'true';
                icon.style.opacity = '0.5';
                icon.style.pointerEvents = 'none';

                // Check subscription status first
                try {
                    const statusResponse = await chrome.runtime.sendMessage({ action: 'CHECK_SUBSCRIPTION_STATUS' });
                    
                    if (!statusResponse?.success) {
                        throw new Error('Unable to verify subscription status');
                    }
                    
                    const status = statusResponse.status;
                    if (!status.active && !status.isTrialing) {
                        // No access - show upgrade message
                        icon.dataset.processing = 'false';
                        icon.style.opacity = '1';
                        icon.style.pointerEvents = 'auto';
                        
                        // Show upgrade notification
                        showUpgradeNotification('Inline reply generation requires an active subscription. Please upgrade to continue using this feature.');
                        return;
                    }
                } catch (error) {
                    console.error('Subscription check failed:', error);
                    icon.dataset.processing = 'false';
                    icon.style.opacity = '1';
                    icon.style.pointerEvents = 'auto';
                    
                    showUpgradeNotification('Unable to verify subscription. Please check your connection and try again.');
                    return;
                }

                // Check AI availability before proceeding
                try {
                    const aiResponse = await chrome.runtime.sendMessage({ action: 'GET_AI_AVAILABILITY' });
                    
                    if (!aiResponse?.success) {
                        throw new Error('Unable to check AI availability');
                    }
                    
                    if (aiResponse.availability === 'downloading') {
                        // AI is downloading - show download message
                        icon.dataset.processing = 'false';
                        icon.style.opacity = '1';
                        icon.style.pointerEvents = 'auto';
                        
                        showDownloadingNotification('AI model is downloading. Please wait a few minutes for the download to complete.');
                        return;
                    } else if (aiResponse.availability !== 'available') {
                        // AI not available - show appropriate message
                        icon.dataset.processing = 'false';
                        icon.style.opacity = '1';
                        icon.style.pointerEvents = 'auto';
                        
                        showDownloadingNotification('AI model is not available. Please download the AI model from the extension popup.');
                        return;
                    }
                } catch (error) {
                    console.error('AI availability check failed:', error);
                    icon.dataset.processing = 'false';
                    icon.style.opacity = '1';
                    icon.style.pointerEvents = 'auto';
                    
                    showDownloadingNotification('Unable to check AI status. Please try again.');
                    return;
                }

                // Get user settings for reply generation
                const settings = await chrome.storage.sync.get(['inlineReplyLength', 'replyMode', 'customPrompt']);
                const replyLength = settings.inlineReplyLength || 'short'; // Default to short for inline

                // Check if custom prompt should be used
                const useCustomPrompt = settings.replyMode === 'custom' && settings.customPrompt?.trim();
                const customPrompt = useCustomPrompt ? settings.customPrompt : null;

                const content = extractThreadContent();
                const originalTitle = icon.title;
                const originalText = icon.textContent;

                // Create and show spinner
                const spinner = createSpinner();
                icon.insertAdjacentElement('afterend', spinner);
                icon.title = 'Generating reply...';
                icon.textContent = '⏳';

                // Generate reply directly without full summarization
                const replyResp = await chrome.runtime.sendMessage({
                    action: 'GENERATE_REPLY',
                    payload: {
                        threadContent: content,
                        summary: { keyPoints: ['Responding to this thread'] },
                        tone: useCustomPrompt ? 'custom' : 'casual',
                        replyLength: replyLength,
                        customPrompt: customPrompt
                    }
                });

                const text = replyResp?.success ? replyResp.reply : 'Thanks for sharing!';

                // Insert text into field
                if (field.tagName === 'TEXTAREA' || field.tagName === 'INPUT') {
                    field.value = text;
                    field.dispatchEvent(new Event('input', { bubbles: true }));
                    field.dispatchEvent(new Event('change', { bubbles: true }));
                } else if (field.isContentEditable) {
                    field.focus();
                    // Use modern approach instead of deprecated execCommand
                    if (document.execCommand) {
                        document.execCommand('insertText', false, text);
                    } else {
                        field.textContent = text;
                    }
                    field.dispatchEvent(new Event('input', { bubbles: true }));
                }

                // Cleanup and restore
                spinner.remove();
                icon.title = originalTitle;
                icon.textContent = originalText;
                icon.style.opacity = '1';

                // Brief success feedback
                icon.textContent = '✅';
                setTimeout(() => {
                    icon.textContent = originalText;
                }, 1000);

            } catch (err) {
                console.warn('Inline reply generation failed:', err);

                // Cleanup on error
                const s = icon.nextSibling;
                if (s && s.getAttribute && s.getAttribute('data-tsp-spinner') !== null) s.remove();

                icon.title = 'Generate reply with AI';
                icon.textContent = '❌';
                setTimeout(() => {
                    icon.textContent = '✨';
                }, 2000);

            } finally {
                // Always restore interactive state
                icon.dataset.processing = 'false';
                icon.style.opacity = '1';
                icon.style.pointerEvents = 'auto';
            }
        };

        const attachToField = (field) => {
            if (!field || field.dataset.tspAttached) return;
            field.dataset.tspAttached = '1';

            const icon = createIcon();
            const parent = field.parentElement || field;
            parent.appendChild(icon);
            icon.addEventListener('click', async (e) => {
                e.stopPropagation();
                await generateForField(field, icon);
            });
            return icon;
        };

        const scan = () => {
            const platform = getCurrentPlatform();
            let selectors = [];
            if (platform === PLATFORMS.TWITTER) {
                selectors = [
                    'div[aria-label="Post your reply"][contenteditable="true"]',
                    'article div[role="textbox"][contenteditable="true"]',
                    'div[role="dialog"] div[role="textbox"][contenteditable="true"]',
                    'div[data-testid^="tweetTextarea_"][contenteditable="true"]'
                ];
            } else if (platform === PLATFORMS.REDDIT) {
                selectors = [
                    'div[role="textbox"][contenteditable="true"]',
                    'textarea[name*="comment"]',
                    'div[contenteditable="true"][data-testid*="comment"]',
                    'textarea[placeholder*="comment" i]',
                    '.usertext-edit textarea',
                    'div[data-testid="comment-body-text-editor"]',
                    // Additional Reddit selectors
                    'div[contenteditable="true"][data-testid="UserText"]',
                    'textarea[data-testid="comment"]',
                    'div[contenteditable="true"][role="textbox"][data-testid*="text-input"]',
                    '.Comment textarea',
                    '.CommentForm textarea',
                    'form[data-testid="comment-submission-form"] textarea',
                    'div[data-click-id="text"] textarea'
                ];
            } else if (platform === PLATFORMS.LINKEDIN) {
                selectors = ['div[contenteditable="true"][role="textbox"]'];
            } else if (platform === PLATFORMS.THREADS) {
                selectors = ['div[contenteditable="true"]'];
            }
            if (selectors.length === 0) return;
            const inputs = document.querySelectorAll(selectors.join(', '));
            inputs.forEach(attachToField);

            if (platform === PLATFORMS.TWITTER) {
                const toolbars = document.querySelectorAll('div[role="group"]');
                toolbars.forEach(svg => {
                    const group = svg;
                    if (!group || group.dataset.tspToolbarAttached) return;
                    const host = group.closest('article, div[role="dialog"]');
                    const editor = host && host.querySelector('div[role="textbox"][contenteditable="true"], div[aria-label="Post your reply"][contenteditable="true"]');
                    if (!editor) return;
                    group.dataset.tspToolbarAttached = '1';
                    const icon = createIcon();
                    icon.style.marginLeft = '10px';
                    group.appendChild(icon);
                    icon.addEventListener('click', () => {
                        const fieldIcon = attachToField(editor) || icon;
                        generateForField(editor, fieldIcon);
                    });
                });
            }

            // Enhanced Reddit support with more selectors
            if (platform === PLATFORMS.REDDIT) {
                console.log('🔍 Scanning for Reddit reply areas...');

                // Comprehensive Reddit selectors for different layouts
                const replySelectors = [
                    // Old Reddit
                    '.usertext-edit textarea',
                    '.usertext-edit div[contenteditable="true"]',

                    // New Reddit
                    '[data-testid="comment-body-text-editor"]',
                    '[data-testid="UserText"] div[contenteditable="true"]',
                    'div[role="textbox"][contenteditable="true"]',

                    // Comment submission forms
                    '[data-testid="comment-submission-form"] textarea',
                    '[data-testid="comment-submission-form"] div[contenteditable="true"]',

                    // Generic Reddit patterns
                    'div[data-click-id="text"] textarea',
                    'div[data-click-id="text"] div[contenteditable="true"]',

                    // Mobile and responsive layouts
                    'textarea[placeholder*="comment" i]',
                    'div[contenteditable="true"][placeholder*="comment" i]',

                    // Fancy Pants Editor
                    '.DraftEditor-root div[contenteditable="true"]',
                    '.public-DraftEditor-content[contenteditable="true"]'
                ];

                let foundCount = 0;
                replySelectors.forEach(selector => {
                    const elements = document.querySelectorAll(selector);
                    elements.forEach(element => {
                        if (!element.dataset.tspAttached) {
                            attachToField(element);
                            foundCount++;
                        }
                    });
                });

                console.log(`📝 Found ${foundCount} Reddit reply areas`);

                // Watch for reply button clicks to catch dynamically loaded forms
                const replyButtonSelectors = [
                    'button[data-click-id="reply"]',
                    '.reply button',
                    'button[aria-label*="reply" i]',
                    'button[title*="reply" i]',
                    '.Comment button[type="button"]',
                    '[data-testid*="reply"] button'
                ];

                replyButtonSelectors.forEach(selector => {
                    const buttons = document.querySelectorAll(selector);
                    buttons.forEach(button => {
                        if (!button.dataset.tspWatched) {
                            button.dataset.tspWatched = '1';
                            button.addEventListener('click', () => {
                                console.log('🔄 Reddit reply button clicked, waiting for form...');
                                // Multiple timeouts to catch different loading speeds
                                [300, 600, 1000].forEach(delay => {
                                    setTimeout(() => {
                                        replySelectors.forEach(selector => {
                                            const newElements = document.querySelectorAll(selector);
                                            newElements.forEach(element => {
                                                if (!element.dataset.tspAttached) {
                                                    attachToField(element);
                                                    console.log('✅ Attached to new Reddit reply form');
                                                }
                                            });
                                        });
                                    }, delay);
                                });
                            });
                        }
                    });
                });
            }
        };
        scan();
        const mo = new MutationObserver(() => scan());
        mo.observe(document.body || document.documentElement, { childList: true, subtree: true });
    } catch (e) {
        console.warn('Inline reply injection error:', e);
    }
})();

// Initialize IntersectionObserver on startup
setTimeout(() => {
    setupScrollObserver();
}, 1000);

// Show upgrade notification for inline features
function showUpgradeNotification(message) {
    // Remove any existing notifications
    const existingNotification = document.querySelector('.threadai-upgrade-notification');
    if (existingNotification) {
        existingNotification.remove();
    }
    
    // Create notification element
    const notification = document.createElement('div');
    notification.className = 'threadai-upgrade-notification';
    
    // Create the notification structure
    const notificationContent = document.createElement('div');
    notificationContent.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: #ffffff;
        color: #374151;
        padding: 16px;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        border: 1px solid #e5e7eb;
        z-index: 10000;
        max-width: 320px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 14px;
        line-height: 1.4;
        animation: slideInRight 0.3s ease-out;
    `;
    
    // Create header
    const header = document.createElement('div');
    header.style.cssText = `
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
        font-weight: 600;
        color: #1f2937;
    `;
    header.innerHTML = `<span style="font-size: 16px;">🔒</span> Upgrade Required`;
    
    // Create message
    const messageDiv = document.createElement('div');
    messageDiv.style.cssText = `
        color: #6b7280;
        margin-bottom: 12px;
        font-size: 13px;
    `;
    messageDiv.textContent = message;
    
    // Create buttons container
    const buttonsContainer = document.createElement('div');
    buttonsContainer.style.cssText = `
        display: flex;
        gap: 8px;
        justify-content: flex-end;
    `;
    
    // Create upgrade button
    const upgradeBtn = document.createElement('button');
    upgradeBtn.textContent = 'Upgrade';
    upgradeBtn.style.cssText = `
        background: #3b82f6;
        color: white;
        border: none;
        padding: 6px 12px;
        border-radius: 4px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        transition: background 0.2s ease;
    `;
    upgradeBtn.addEventListener('mouseenter', () => {
        upgradeBtn.style.background = '#2563eb';
    });
    upgradeBtn.addEventListener('mouseleave', () => {
        upgradeBtn.style.background = '#3b82f6';
    });
    upgradeBtn.addEventListener('click', async () => {
        notification.remove();
        await handleInlineUpgrade();
    });
    
    // Create dismiss button
    const dismissBtn = document.createElement('button');
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.style.cssText = `
        background: transparent;
        color: #6b7280;
        border: 1px solid #d1d5db;
        padding: 6px 12px;
        border-radius: 4px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s ease;
    `;
    dismissBtn.addEventListener('mouseenter', () => {
        dismissBtn.style.background = '#f3f4f6';
        dismissBtn.style.color = '#374151';
    });
    dismissBtn.addEventListener('mouseleave', () => {
        dismissBtn.style.background = 'transparent';
        dismissBtn.style.color = '#6b7280';
    });
    dismissBtn.addEventListener('click', () => {
        notification.remove();
    });
    
    // Create close button
    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = '×';
    closeBtn.style.cssText = `
        position: absolute;
        top: 8px;
        right: 8px;
        background: none;
        border: none;
        color: #9ca3af;
        font-size: 16px;
        cursor: pointer;
        padding: 4px;
        line-height: 1;
        transition: color 0.2s ease;
    `;
    closeBtn.addEventListener('mouseenter', () => {
        closeBtn.style.color = '#374151';
    });
    closeBtn.addEventListener('mouseleave', () => {
        closeBtn.style.color = '#9ca3af';
    });
    closeBtn.addEventListener('click', () => {
        notification.remove();
    });
    
    // Assemble notification
    buttonsContainer.appendChild(upgradeBtn);
    buttonsContainer.appendChild(dismissBtn);
    
    notificationContent.appendChild(header);
    notificationContent.appendChild(messageDiv);
    notificationContent.appendChild(buttonsContainer);
    notificationContent.appendChild(closeBtn);
    
    notification.appendChild(notificationContent);
    
    // Add animation styles
    if (!document.querySelector('#threadai-notification-styles')) {
        const style = document.createElement('style');
        style.id = 'threadai-notification-styles';
        style.textContent = `
            @keyframes slideInRight {
                from {
                    transform: translateX(100%);
                    opacity: 0;
                }
                to {
                    transform: translateX(0);
                    opacity: 1;
                }
            }
        `;
        document.head.appendChild(style);
    }
    
    // Add to page
    document.body.appendChild(notification);
    
    // Auto-remove after 8 seconds
    setTimeout(() => {
        if (notification.parentNode) {
            notification.style.animation = 'slideInRight 0.3s ease-out reverse';
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.remove();
                }
            }, 300);
        }
    }, 8000);
}

// Handle upgrade click for inline notifications
async function handleInlineUpgrade() {
    try {
        const email = prompt('Enter your email address to upgrade:');
        if (!email || !email.includes('@')) {
            alert('Please enter a valid email address.');
            return;
        }

        const response = await chrome.runtime.sendMessage({ 
            action: 'GENERATE_CHECKOUT_URL', 
            payload: { email, plan: 'pro-monthly' } 
        });

        if (response?.success) {
            // Store checkout timestamp for payment completion detection
            await chrome.storage.local.set({ 'lastCheckoutTime': Date.now() });
            
            window.open(response.url, '_blank');
            
            // Show success notification
            showSimpleNotification('Opening checkout page... We\'ll automatically detect when payment is complete.', 'success');
        } else {
            showSimpleNotification('Failed to open checkout page. Please try again.', 'error');
        }
    } catch (error) {
        console.error('Upgrade error:', error);
        showSimpleNotification('Failed to open upgrade page. Please try again.', 'error');
    }
}

// Simple notification for feedback
function showSimpleNotification(message, type = 'info') {
    const notification = document.createElement('div');
    const bgColor = type === 'success' ? '#10b981' : type === 'error' ? '#ef4444' : '#3b82f6';
    
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: ${bgColor};
        color: white;
        padding: 12px 16px;
        border-radius: 6px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        z-index: 10001;
        max-width: 300px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 13px;
        line-height: 1.4;
        animation: slideInRight 0.3s ease-out;
    `;
    notification.textContent = message;
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
        if (notification.parentNode) {
            notification.style.animation = 'slideInRight 0.3s ease-out reverse';
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.remove();
                }
            }, 300);
        }
    }, 4000);
}

// Lightweight downloading notification
function showDownloadingNotification(message) {
    // Remove any existing downloading notifications
    const existingNotification = document.querySelector('.threadai-downloading-notification');
    if (existingNotification) {
        existingNotification.remove();
    }
    
    // Create notification element
    const notification = document.createElement('div');
    notification.className = 'threadai-downloading-notification';
    
    // Create the notification structure
    const notificationContent = document.createElement('div');
    notificationContent.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: #f59e0b;
        color: white;
        padding: 12px 16px;
        border-radius: 6px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        z-index: 10002;
        max-width: 320px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 13px;
        line-height: 1.4;
        animation: slideInRight 0.3s ease-out;
        display: flex;
        align-items: center;
        gap: 8px;
    `;
    
    // Create spinner
    const spinner = document.createElement('div');
    spinner.style.cssText = `
        width: 16px;
        height: 16px;
        border: 2px solid rgba(255, 255, 255, 0.3);
        border-top: 2px solid white;
        border-radius: 50%;
        animation: spin 1s linear infinite;
        flex-shrink: 0;
    `;
    
    // Create message
    const messageDiv = document.createElement('div');
    messageDiv.textContent = message;
    messageDiv.style.cssText = `
        flex: 1;
        font-weight: 500;
    `;
    
    // Assemble notification
    notificationContent.appendChild(spinner);
    notificationContent.appendChild(messageDiv);
    notification.appendChild(notificationContent);
    
    // Add spinner animation if not already added
    if (!document.querySelector('#threadai-spinner-styles')) {
        const style = document.createElement('style');
        style.id = 'threadai-spinner-styles';
        style.textContent = `
            @keyframes spin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }
            @keyframes slideInRight {
                from {
                    transform: translateX(100%);
                    opacity: 0;
                }
                to {
                    transform: translateX(0);
                    opacity: 1;
                }
            }
        `;
        document.head.appendChild(style);
    }
    
    // Add to page
    document.body.appendChild(notification);
    
    // Auto-remove after 5 seconds
    setTimeout(() => {
        if (notification.parentNode) {
            notification.style.animation = 'slideInRight 0.3s ease-out reverse';
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.remove();
                }
            }, 300);
        }
    }, 5000);
}