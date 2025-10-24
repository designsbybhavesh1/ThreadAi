⚠️ **Important Note**

This project is open-sourced for transparency and submission review purposes only.  
While the source code is publicly visible, **it should not be reused, redistributed, or repurposed** for any commercial or derivative product.

ThreadAi includes proprietary logic and subscription-based features that are part of an upcoming SaaS platform.

Please do not clone, modify, or share this project outside of personal review or evaluation. 

it's a request.


# 🧠 ThreadAI - Chrome Extension

**ThreadAI** is a Chrome extension that helps you summarize social threads, extract key insights, quotes, and generate smart, context-aware replies with customizations, powered by Chrome’s built-in AI.

---

## 🚀 Features

- 🧾 Summarizes long threads into clear bullet points and quotes
- 💬 Generates quick, natural AI-powered replies on extension with tone options 
- 💬 Inline reply generation on X and LinkedIn by ✨ reply icon button on your platform's reply toolbar 
- ✨ Highlights key quotes and insights  
- ⚡ Works locally with Chrome’s built-in AI - no external API needed  
- 💾 Customize reply generation by custom prompt and key point styles, lenght etc.. 
- 💾 Interface seetings - enabale or disbale ✨ reply icon button on your platform's reply toolbar 
- 💡 Trial abuse prevention using backend : max 72 hours trial 

---

## 🛠️ Built With

- **JavaScript (Vanilla)** — Core logic and UI interactions  
- **Manifest V3** — Modern, secure Chrome extension architecture  
- **Chrome Built-in AI (Gemini Nano)** (Prompt API) — On-device summarization and reply generation  
- **Chrome Local Storage** — Lightweight, privacy-friendly data storage  
- **Cloudflare Workers** — Handles backend logic and analytics  

---

## 💡 Inspiration

I often read long threads full of great discussions but found it hard to remember all the key points or craft thoughtful replies quickly.  
ThreadAI was built to simplify that — to help users understand, engage, and reply smarter without switching apps or copying text around.

---

## ⚙️ Setup Instructions

Just try this link : https://chromewebstore.google.com/detail/bijmigmaoamdihobhdpaikgkjdkjpfgf?utm_source=item-share-cb

OR

### 1. Clone the Repository
bash
git clone https://github.com/yourusername/repo-name.git

cd ThreadAi

2. Load the Extension in Chrome

Open chrome://extensions/

Enable Developer mode

Click Load unpacked

Select the cloned threadai-extension folder(extract folder if not extracted)

it requires download of chrome ai model on your device , it may take few minuts(1-2) as per your device performance
Works better on modern pc, not for low end devices


3. Cloudflare worker is already deployed, no need to manage backend by your side - just load unpacked and use / downlaod from chrome webstore and use 
Chrome webstore link : https://chromewebstore.google.com/detail/bijmigmaoamdihobhdpaikgkjdkjpfgf?utm_source=item-share-cb
(version 1.0.10)


🤝 Contributing

Contributions, feedback, and suggestions are always welcome!

📜 License

This project is licensed under the MIT License — see the LICENSE
 file for details.

**🌍 Links**

Chrome Web Store: https://chromewebstore.google.com/detail/bijmigmaoamdihobhdpaikgkjdkjpfgf?utm_source=item-share-cb

Live Demo  : https://www.youtube.com/watch?v=3qW-iANSGQQ

Author: Bhavesh Lalvani
