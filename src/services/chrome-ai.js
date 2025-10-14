// src/services/chrome-ai.js

/**
 * Clean, optimized Chrome AI service with proper session management
 */

// Removed performance monitoring for speed optimization

// Simple session management
let cachedSession = null;
let sessionCreatedAt = 0;
let isInitializing = false;
const SESSION_CACHE_DURATION = 1800000; // 30 minutes

class ChromeAIService {
    constructor() {
        this.sessionPromise = null; // Cache session promise to avoid duplicate initialization
    }

    /**
     * Get availability of Chrome AI
     */
    async getAvailability() {
        try {
            if (!self.LanguageModel) {
                return 'unavailable';
            }
            return await self.LanguageModel.availability();
        } catch (error) {
            console.error("ChromeAIService.getAvailability error:", error);
            return 'unavailable';
        }
    }

    /**
     * Get or create AI session with promise caching for optimal performance
     */
    async getSession() {
        const now = Date.now();

        // Return cached session immediately if available and fresh
        if (cachedSession && (now - sessionCreatedAt) < SESSION_CACHE_DURATION) {
            return cachedSession;
        }

        // Return existing promise if already initializing
        if (this.sessionPromise) {
            return this.sessionPromise;
        }

        // Create and cache the session promise
        this.sessionPromise = this._createSession();
        try {
            cachedSession = await this.sessionPromise;
            sessionCreatedAt = Date.now();
            return cachedSession;
        } catch (error) {
            this.sessionPromise = null; // Clear failed promise
            throw error;
        }
    }

    async _createSession() {
        const availability = await this.getAvailability();
        if (availability !== 'available') {
            throw new Error(`AI not available: ${availability}`);
        }

        console.log('🤖 Creating AI session...');
        const session = await self.LanguageModel.create({
            temperature: 0.2,
            topK: 10
        });

        // Pre-warm session for faster first response
        try {
            await session.prompt('Hi');
            console.log('🔥 Session pre-warmed');
        } catch (e) {
            console.warn('Pre-warm failed, but session created');
        }

        console.log('✅ AI session created');
        return session;
    }

    /**
     * Quick session check (lightweight)
     */
    async quickCheck() {
        try {
            if (cachedSession) return true;
            const availability = await this.getAvailability();
            return availability === 'available';
        } catch (error) {
            return false;
        }
    }

    /**
     * Test AI with a simple prompt to verify it's working
     */
    async testAI() {
        try {
            console.log('🧪 Testing AI with simple prompt...');
            const session = await this.getSession();
            const response = await session.prompt('Say "AI is working" in JSON format: {"status": "working"}');
            console.log('🧪 AI test response:', response);
            return response.includes('working');
        } catch (error) {
            console.error('🧪 AI test failed:', error);
            return false;
        }
    }

    /**
     * Simplified download with better stuck detection
     */
    async downloadModelWithProgress(progressCallback) {
        console.log('🤖 Starting model download...');

        // Show initial preparation message
        progressCallback(0, 'preparing', 'Preparing to download AI model...');

        return new Promise(async (resolve, reject) => {
            let lastProgress = 0;
            let stuckCount = 0;
            let progressTimeout = null;
            let hasShown80Message = false;

            try {
                // Start progress monitoring
                const startMonitoring = () => {
                    progressTimeout = setTimeout(async () => {
                        console.log('⚠️ Progress stuck, testing if model is actually ready...');
                        try {
                            // Test if model is functional even if progress is stuck
                            const testSession = await self.LanguageModel.create();
                            await this.testModelFunctionality(testSession);
                            console.log('✅ Model is ready despite stuck progress!');
                            progressCallback(100, 'ready');
                            resolve(testSession);
                        } catch (error) {
                            console.log('❌ Model not ready yet, continuing...');
                            startMonitoring(); // Continue monitoring
                        }
                    }, 10000); // Check every 10 seconds if stuck
                };

                const session = await self.LanguageModel.create({
                    monitor: (monitor) => {
                        monitor.addEventListener('downloadprogress', (event) => {
                            let progress = 0;

                            if (event.total && event.total > 0) {
                                progress = Math.min(Math.round((event.loaded / event.total) * 100), 100);
                            } else if (event.loaded <= 1) {
                                progress = Math.min(Math.round(event.loaded * 100), 100);
                            }

                            console.log(`📊 Download progress: ${progress}%`);

                            // Show appropriate messages based on progress
                            if (progress <= 1) {
                                progressCallback(progress, 'downloading', 'Starting download... This may take a few minutes.');
                            } else if (progress >= 80 && !hasShown80Message) {
                                progressCallback(progress, 'finalizing', 'Download may jump directly to 100% - this is normal!');
                                hasShown80Message = true;
                            } else if (progress >= 80) {
                                // Continue showing the 80% message for all progress >= 80
                                progressCallback(progress, 'finalizing', 'Download may jump directly to 100% - this is normal!');
                            } else {
                                progressCallback(progress, 'downloading');
                            }

                            // Reset stuck detection if progress is moving
                            if (progress > lastProgress) {
                                lastProgress = progress;
                                stuckCount = 0;
                                if (progressTimeout) {
                                    clearTimeout(progressTimeout);
                                    startMonitoring();
                                }
                            } else {
                                stuckCount++;
                            }

                            // If we reach 100%, test functionality
                            if (progress >= 100) {
                                if (progressTimeout) clearTimeout(progressTimeout);
                                progressCallback(100, 'testing', 'Testing AI model functionality...');
                                this.testModelFunctionality(session)
                                    .then(() => {
                                        console.log('✅ Model fully functional');
                                        progressCallback(100, 'ready', 'AI model is ready to use!');
                                        resolve(session);
                                    })
                                    .catch((error) => {
                                        console.error('💥 Model test failed:', error);
                                        reject(error);
                                    });
                            }
                        });

                        monitor.addEventListener('error', (error) => {
                            if (progressTimeout) clearTimeout(progressTimeout);
                            console.error('💥 Download error:', error);
                            reject(new Error(`Download failed: ${error.message}`));
                        });
                    }
                });

                // Start stuck detection
                startMonitoring();

            } catch (error) {
                if (progressTimeout) clearTimeout(progressTimeout);
                reject(error);
            }
        });
    }

    /**
     * Test model functionality to ensure it's actually ready
     */
    async testModelFunctionality(session) {
        console.log('🧪 Testing model functionality...');

        try {
            // Test with a simple prompt
            const testPrompt = 'Say "test" in JSON format: {"result": "test"}';
            const response = await Promise.race([
                session.prompt(testPrompt),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Test timeout')), 10000))
            ]);

            if (response && response.includes('test')) {
                console.log('✅ Model functionality test passed');
                return true;
            } else {
                throw new Error('Model response invalid');
            }
        } catch (error) {
            console.error('💥 Model functionality test failed:', error);
            throw error;
        }
    }



    /**
     * Summarize thread content with optimized performance and settings compliance
     */
    async summarizeThread(threadContent, settings = {}) {
        if (!threadContent || !threadContent.text || threadContent.text.trim().length === 0) {
            throw new Error("No content to summarize");
        }

        try {
            console.log("🚀 Starting AI summarization...");

            // Check AI availability first
            const availability = await this.getAvailability();
            console.log(`🔍 AI availability: ${availability}`);

            if (availability !== 'available') {
                console.warn('⚠️ AI not available, using fallback');
                return this.createFallbackSummary(threadContent.text, settings);
            }

            let session;
            try {
                session = await this.getSession();
                console.log("✅ AI session ready");
            } catch (error) {
                console.warn('⚠️ Failed to get session, using fallback');
                return this.createFallbackSummary(threadContent.text, settings);
            }

            // Apply user settings for processing speed and style
            const processingSpeed = settings.processingSpeed || 'balanced';
            const keyPointsStyle = settings.keyPointsStyle || 'default';

            // Smart content analysis with speed optimization
            const wordCount = threadContent.text.split(/\s+/).length;

            // Dynamic points count based on content length and style
            let pointsCount;
            if (keyPointsStyle === 'brief') {
                pointsCount = Math.min(Math.max(2, Math.floor(wordCount / 120)), 5);
            } else if (keyPointsStyle === 'oneline') {
                pointsCount = Math.min(Math.max(3, Math.floor(wordCount / 80)), 6);
            } else {
                // Default: more dynamic based on content
                if (wordCount < 100) {
                    pointsCount = 2;
                } else if (wordCount < 300) {
                    pointsCount = 3;
                } else if (wordCount < 600) {
                    pointsCount = 4;
                } else if (wordCount < 1000) {
                    pointsCount = 5;
                } else {
                    pointsCount = 6;
                }
            }

            // Optimize content limit based on processing speed (reduced for better JSON completion)
            let contentLimit;
            switch (processingSpeed) {
                case 'fast':
                    contentLimit = 800;  // Reduced for faster, more complete responses
                    break;
                case 'quality':
                    contentLimit = 1500; // Reduced to prevent truncation
                    break;
                default:
                    contentLimit = 1200; // Reduced for better completion rate
            }

            const limitedContent = threadContent.text.substring(0, contentLimit);

            // Build style-specific prompt
            let styleInstruction;
            switch (keyPointsStyle) {
                case 'oneline':
                    styleInstruction = 'Each key point must be exactly one complete sentence, maximum 20 words';
                    break;
                case 'brief':
                    styleInstruction = 'Each key point should be brief and concise, 10-15 words maximum';
                    break;
                default:
                    styleInstruction = 'Each key point should be detailed and insightful';
            }

            // Improved prompt for complete JSON responses
            const prompt = `Summarize this content and return ONLY valid JSON:

${limitedContent}

Format (exactly ${pointsCount} points, 1-2 quotes):
{"keyPoints":["brief point 1","brief point 2"],"quotes":["short quote"]}

JSON:`;

            // More realistic timeouts for better success rate
            let timeoutMs;
            switch (processingSpeed) {
                case 'fast':
                    timeoutMs = 8000;  // Increased from 3000
                    break;
                case 'quality':
                    timeoutMs = 15000; // Increased from 8000
                    break;
                default:
                    timeoutMs = 12000; // Increased from 5000
            }

            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('AI processing timeout')), timeoutMs)
            );

            let rawResponse;
            try {
                const promptStart = Date.now();
                console.log(`🤖 Sending prompt to AI (timeout: ${timeoutMs}ms)...`);
                rawResponse = await Promise.race([session.prompt(prompt), timeoutPromise]);
                const responseTime = Date.now() - promptStart;
                console.log(`⚡ AI response received in ${responseTime}ms`);
                console.log(`📝 Raw AI response: ${rawResponse.substring(0, 200)}...`);
            } catch (error) {
                console.warn('⚠️ AI processing failed:', error.message);

                // If session was destroyed, try to recreate it once
                if (error.message.includes('destroyed') || error.message.includes('session')) {
                    console.log('🔄 Session destroyed, attempting to recreate...');
                    try {
                        cachedSession = null; // Clear cached session
                        session = await this.getSession();
                        rawResponse = await Promise.race([session.prompt(prompt), timeoutPromise]);
                        console.log('✅ Session recreated successfully');
                    } catch (retryError) {
                        console.warn('⚠️ Session recreation failed:', retryError.message);
                        console.log('🔄 Using fallback summary instead');
                        return this.createFallbackSummary(threadContent.text, settings);
                    }
                } else {
                    console.log('🔄 Using fallback summary instead');
                    return this.createFallbackSummary(threadContent.text, settings);
                }
            }

            // Parse JSON response with better error handling and repair
            let jsonMatch = rawResponse.match(/\{.*\}/s);
            if (!jsonMatch) {
                console.warn("⚠️ No JSON found in AI response:", rawResponse.substring(0, 100));
                return this.createFallbackSummary(threadContent.text, settings);
            }

            let jsonString = jsonMatch[0];
            let parsed;

            try {
                parsed = JSON.parse(jsonString);
                console.log("✅ Successfully parsed AI JSON response");
            } catch (parseError) {
                console.warn("⚠️ JSON parse error, attempting to repair:", parseError.message);
                console.log("📝 Original JSON:", jsonString.substring(0, 200));

                // Try to repair incomplete JSON
                try {
                    // If JSON is truncated, try to close it properly
                    if (!jsonString.endsWith('}')) {
                        // Find the last complete key-value pair
                        const lastComma = jsonString.lastIndexOf(',');
                        const lastQuote = jsonString.lastIndexOf('"');

                        if (lastComma > lastQuote) {
                            // Remove incomplete entry after last comma
                            jsonString = jsonString.substring(0, lastComma) + '}';
                        } else if (lastQuote > 0) {
                            // Close the string and object
                            jsonString = jsonString + '"}';
                        } else {
                            // Add closing brace
                            jsonString = jsonString + '}';
                        }
                    }

                    parsed = JSON.parse(jsonString);
                    console.log("✅ Successfully repaired and parsed JSON");
                } catch (repairError) {
                    console.warn("⚠️ Could not repair JSON, using fallback");
                    return this.createFallbackSummary(threadContent.text, settings);
                }
            }

            // Validate and clean response according to settings
            let keyPoints = Array.isArray(parsed.keyPoints) ? parsed.keyPoints : [];

            // Enforce style constraints
            if (keyPointsStyle === 'oneline') {
                keyPoints = keyPoints.map(point => {
                    const words = point.split(' ');
                    return words.length > 20 ? words.slice(0, 20).join(' ') + '...' : point;
                });
            } else if (keyPointsStyle === 'brief') {
                keyPoints = keyPoints.map(point => {
                    const words = point.split(' ');
                    return words.length > 15 ? words.slice(0, 15).join(' ') + '...' : point;
                });
            }

            const quotes = Array.isArray(parsed.quotes) ? parsed.quotes.slice(0, 2) : [];

            return {
                keyPoints: keyPoints.length > 0 ? keyPoints : ["Summary not available"],
                quotes: quotes,
                sentiment: "neutral",
                wordCount: wordCount,
                timeToRead: Math.max(1, Math.ceil(wordCount / 200))
            };

        } catch (error) {
            console.error("💥 Summarization error:", error);
            return this.createFallbackSummary(threadContent.text, settings);
        }
    }

    /**
     * Generate reply with custom prompt support and flexible length control
     */
    async generateReply(threadContent, summary, tone = 'casual', replyLength = 'short', customPrompt = null) {
        if (!threadContent || !threadContent.text) {
            throw new Error("No content for reply generation");
        }

        try {
            console.log(`🚀 Generating reply (${customPrompt ? 'custom' : replyLength})...`);
            const session = await this.getSession();

            const limitedContent = threadContent.text.substring(0, 300);
            const keyPoints = summary.keyPoints ? summary.keyPoints.slice(0, 1) : [];

            let prompt;
            let maxWords, minWords, lengthInstruction;

            if (customPrompt && customPrompt.trim()) {
                // For custom prompts: NO length restrictions, let user control everything
                prompt = `Reply to this social media thread with substance and relevance.

User's Instructions: ${customPrompt.trim()}

Context: ${keyPoints[0] || 'General discussion'}

Thread Content: ${limitedContent.substring(0, 300)}

Focus on the actual topic and content. Avoid generic phrases like "thanks for sharing" or "totally agree". Add your own perspective or insight about the specific topic discussed:`;

                // No length limits for custom prompts - user controls this
                maxWords = 300; // Very generous limit
                minWords = 1;   // Allow even single words
            } else {
                // Default system prompts with improved short length (2-3 lines)
                switch (replyLength) {
                    case 'short':
                        lengthInstruction = 'Write exactly ONE short sentence. Maximum 16 words. Keep it concise and engaging.';
                        maxWords = 16;  // Reduced to 12-16 words for 1-line replies
                        minWords = 8;   // Minimum 8 words for meaningful content
                        break;
                    case 'medium':
                        lengthInstruction = 'Write 2-3 complete sentences. Be thoughtful and engaging.';
                        maxWords = 40;
                        minWords = 10;
                        break;
                    default:
                        lengthInstruction = 'Write 2-4 complete sentences. Be comprehensive but concise.';
                        maxWords = 60;
                        minWords = 12;
                }

                prompt = `Write a ${tone} reply about the actual topic discussed.

FOCUS:
- ${lengthInstruction}
- Stay on topic and add substance
- Use a ${tone} tone
- Avoid generic phrases like "thanks for sharing", "totally agree", "fascinating point"
- Comment on the specific content, not just politeness

Topic: ${keyPoints[0] || 'General discussion'}

Content: ${limitedContent.substring(0, 200)}

Reply with your own perspective on this topic:`;
            }

            const timeoutMs = 6000;
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Reply timeout')), timeoutMs)
            );

            let result;
            try {
                result = await Promise.race([session.prompt(prompt), timeoutPromise]);
            } catch (error) {
                return this.createFallbackReply(tone, replyLength);
            }

            // Clean and validate reply
            let cleanReply = result ? result.trim() : this.createFallbackReply(tone, replyLength);

            // Remove common prefixes and suffixes
            cleanReply = cleanReply
                .replace(/^(Reply:|Response:|Here's a reply:|My reply:|Answer:)/i, '')
                .trim();

            // Enhanced cleanup for better quality
            cleanReply = this.enhancedReplyCleanup(cleanReply);

            if (customPrompt && customPrompt.trim()) {
                // For custom prompts: minimal processing, respect user's intent
                const replyType = 'custom';
                const words = cleanReply.split(/\s+/).filter(w => w.length > 0);
                console.log(`✅ Generated ${replyType} reply (${words.length} words) - no length restrictions`);
                return cleanReply;
            } else {
                // For system prompts: apply length enforcement and quality controls
                cleanReply = cleanReply.replace(/\n.*$/s, '').trim(); // Remove everything after first line break

                const words = cleanReply.split(/\s+/).filter(w => w.length > 0);

                if (replyLength === 'short') {
                    if (words.length > maxWords) {
                        // Take first sentence or first maxWords
                        const firstSentence = cleanReply.split(/[.!?]/)[0].trim();
                        const firstSentenceWords = firstSentence.split(/\s+/).filter(w => w.length > 0);

                        if (firstSentenceWords.length <= maxWords && firstSentenceWords.length >= minWords) {
                            cleanReply = firstSentence + (firstSentence.match(/[.!?]$/) ? '' : '.');
                        } else {
                            cleanReply = words.slice(0, maxWords).join(' ') + '.';
                        }
                    }
                } else if (words.length > maxWords) {
                    cleanReply = words.slice(0, maxWords).join(' ') + '.';
                }

                // Final validation for system prompts
                const finalWords = cleanReply.split(/\s+/).filter(w => w.length > 0);
                if (finalWords.length < minWords || finalWords.length > maxWords) {
                    return this.createFallbackReply(tone, replyLength);
                }

                const replyType = tone;
                console.log(`✅ Generated ${replyType} reply (${finalWords.length}/${maxWords} words)`);
                return cleanReply;
            }

        } catch (error) {
            console.error("💥 Reply generation error:", error);
            return this.createFallbackReply(tone, replyLength);
        }
    }

    /**
     * Enhanced reply cleanup to remove duplicates and fix incomplete sentences
     */
    enhancedReplyCleanup(reply) {
        if (!reply || reply.trim().length === 0) {
            return reply;
        }

        let cleaned = reply.trim();

        // Remove multiple spaces and normalize whitespace
        cleaned = cleaned.replace(/\s+/g, ' ').trim();

        // Split into sentences for duplicate detection
        // Handle cases like "cool.@user" and "cool. @user" and "cool. Building"
        const sentences = cleaned.split(/(?<=[.!?])(?:\s+|(?=[@#A-Z]))/).filter(s => s.trim().length > 0);

        // Remove duplicate sentences (case-insensitive)
        const uniqueSentences = [];
        const seenSentences = new Set();

        for (const sentence of sentences) {
            const trimmedSentence = sentence.trim();
            if (trimmedSentence.length === 0) continue;

            // Normalize for comparison: remove punctuation, mentions, hashtags, and extra spaces
            const normalizedSentence = trimmedSentence
                .toLowerCase()
                .replace(/@\w+/g, '') // Remove mentions for comparison
                .replace(/#\w+/g, '') // Remove hashtags for comparison
                .replace(/[^\w\s]/g, '') // Remove punctuation
                .replace(/\s+/g, ' ') // Normalize spaces
                .trim();

            // Skip if we've seen this sentence before (allowing for minor variations)
            if (!seenSentences.has(normalizedSentence) && normalizedSentence.length > 3) {
                uniqueSentences.push(trimmedSentence);
                seenSentences.add(normalizedSentence);
            }
        }

        // Rejoin unique sentences
        cleaned = uniqueSentences.join(' ');

        // Fix incomplete sentences at the end
        cleaned = this.fixIncompleteEnding(cleaned);

        // Remove any trailing incomplete words or fragments
        cleaned = cleaned.replace(/\s+[a-zA-Z]{1,2}$/, ''); // Remove 1-2 letter words at end
        // Note: Mentions and hashtags are preserved as they may be intentional

        return cleaned.trim();
    }

    /**
     * Fix incomplete sentence endings
     */
    fixIncompleteEnding(text) {
        if (!text || text.trim().length === 0) {
            return text;
        }

        let fixed = text.trim();

        // If text doesn't end with proper punctuation, try to fix it
        if (!fixed.match(/[.!?]$/)) {
            // If it ends with a complete word, add a period
            if (fixed.match(/\w$/)) {
                fixed += '.';
            } else {
                // If it ends with incomplete text, try to find the last complete sentence
                const lastSentenceMatch = fixed.match(/(.*[.!?])/);
                if (lastSentenceMatch) {
                    fixed = lastSentenceMatch[1];
                } else {
                    // If no complete sentence found, add period to make it complete
                    fixed = fixed.replace(/[^\w\s]*$/, '') + '.';
                }
            }
        }

        return fixed;
    }

    /**
     * Create fallback summary from text analysis with settings support
     */
    createFallbackSummary(text, settings = {}) {
        console.warn("⚠️ Using text analysis fallback");

        const keyPointsStyle = settings.keyPointsStyle || 'default';
        const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 20);

        let keyPoints;
        switch (keyPointsStyle) {
            case 'oneline':
                keyPoints = sentences.slice(0, 3).map(s => {
                    const words = s.trim().split(' ').slice(0, 20);
                    return words.join(' ') + (words.length === 20 ? '...' : '');
                });
                break;
            case 'brief':
                keyPoints = sentences.slice(0, 4).map(s => {
                    const words = s.trim().split(' ').slice(0, 15);
                    return words.join(' ') + (words.length === 15 ? '...' : '');
                });
                break;
            default:
                keyPoints = sentences.slice(0, 3).map(s => s.trim().substring(0, 150));
        }

        if (keyPoints.length === 0) {
            keyPoints.push(text.substring(0, 100));
        }

        const quotes = [];
        if (sentences.length > 2) {
            quotes.push(sentences[Math.floor(sentences.length / 2)].trim().substring(0, 120));
        }

        const words = text.split(/\s+/).length;

        return {
            keyPoints,
            quotes,
            sentiment: 'neutral',
            wordCount: words,
            timeToRead: Math.max(1, Math.ceil(words / 200)),
            fallback: true
        };
    }

    /**
     * Create fallback reply with improved quality and length control
     */
    createFallbackReply(tone, replyLength = 'short') {
        const replies = {
            casual: {
                short: "This makes sense.",
                medium: "I see your point about this. It's worth considering.",
                default: "This perspective adds value to the discussion. The approach you mentioned could work well."
            },
            professional: {
                short: "Valid observation.",
                medium: "This analysis provides useful context. The implications are noteworthy.",
                default: "This assessment offers valuable insights. The methodology and conclusions merit further consideration."
            },
            witty: {
                short: "Solid take.",
                medium: "Now that's a perspective worth exploring. The logic checks out.",
                default: "This hits the mark. The reasoning is sound and the implications are interesting to consider."
            },
            friendly: {
                short: "Good insight!",
                medium: "This perspective really adds to the conversation. I hadn't considered that angle.",
                default: "This brings up some really good points. The way you've framed this issue opens up new ways of thinking about it."
            }
        };

        const toneReplies = replies[tone] || replies.casual;
        return toneReplies[replyLength] || toneReplies.short; // Default to short for better UX
    }

    /**
     * Clean up resources
     */
    cleanup() {
        if (cachedSession) {
            try {
                cachedSession.destroy?.();
            } catch (error) {
                console.warn('Session cleanup warning:', error);
            }
            cachedSession = null;
            sessionCreatedAt = 0;
        }
    }
}

// Export singleton
export default new ChromeAIService();