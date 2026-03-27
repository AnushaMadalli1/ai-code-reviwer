let editor;
let fixedCode = "";
let currentReviewData = null;
let filesToReview = [];
let currentFileIndex = -1;
let reviewsResults = [];

let chatHistory = [];

// Initialize Monaco Editor
let editorReady = false;
require.config({ paths: { 'vs': 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs' } });
require(['vs/editor/editor.main'], function () {
    editor = monaco.editor.create(document.getElementById('monaco-container'), {
        value: "// Paste your code here or upload a file...",
        language: 'javascript',
        theme: 'vs-dark',
        automaticLayout: true,
        fontSize: 14,
        fontFamily: 'JetBrains Mono',
        minimap: { enabled: false },
        lineNumbers: 'on',
        roundedSelection: true,
        scrollBeyondLastLine: false,
        readOnly: false,
        cursorStyle: 'line',
        padding: { top: 20 }
    });

    editor.onDidChangeModelContent(() => {
        const value = editor.getValue();
        const lines = value.split('\n').length;
        const chars = value.length;
        document.getElementById('editor-stats').innerText = `Lines: ${lines} | Chars: ${chars}`;
    });

    editorReady = true;
    console.log("Monaco Editor ready.");
});

// Matrix Background Effect
const canvas = document.getElementById('matrix-bg');
const ctx = canvas.getContext('2d');
let width, height, columns, drops;

function initMatrix() {
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
    columns = Math.floor(width / 20);
    drops = Array(columns).fill(1);
}

function drawMatrix() {
    ctx.fillStyle = 'rgba(10, 10, 15, 0.05)';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#00ff88';
    ctx.font = '15px monospace';

    for (let i = 0; i < drops.length; i++) {
        const text = String.fromCharCode(Math.random() * 128);
        ctx.fillText(text, i * 20, drops[i] * 20);
        if (drops[i] * 20 > height && Math.random() > 0.975) drops[i] = 0;
        drops[i]++;
    }
}

window.addEventListener('resize', initMatrix);
initMatrix();
setInterval(drawMatrix, 50);

// Typing Animation
const typingText = document.getElementById('typing-text');
const phrases = ["Analyze. Debug. Improve. Secure.", "Detect Bugs Instantly.", "Optimize Your Workflow.", "Secure Your Codebase."];
let phraseIdx = 0;
let charIdx = 0;
let isDeleting = false;

function type() {
    const currentPhrase = phrases[phraseIdx];
    if (isDeleting) {
        typingText.innerText = currentPhrase.substring(0, charIdx - 1);
        charIdx--;
    } else {
        typingText.innerText = currentPhrase.substring(0, charIdx + 1);
        charIdx++;
    }

    let typeSpeed = isDeleting ? 50 : 100;
    if (!isDeleting && charIdx === currentPhrase.length) {
        typeSpeed = 2000;
        isDeleting = true;
    } else if (isDeleting && charIdx === 0) {
        isDeleting = false;
        phraseIdx = (phraseIdx + 1) % phrases.length;
        typeSpeed = 500;
    }
    setTimeout(type, typeSpeed);
}
type();

// Folder Upload
document.getElementById('folder-upload').addEventListener('change', function(e) {
    const files = Array.from(e.target.files);
    filesToReview = files.filter(f => f.size < 500000).slice(0, 10);
    if (filesToReview.length === 0) return alert("No valid files found (max 10 files, <500KB each)");
    
    document.getElementById('file-tabs').classList.remove('hidden');
    renderTabs();
    loadTab(0);
});

function renderTabs() {
    const container = document.getElementById('file-tabs');
    container.innerHTML = '';
    filesToReview.forEach((file, idx) => {
        const tab = document.createElement('div');
        tab.className = `file-tab ${idx === currentFileIndex ? 'active' : ''}`;
        tab.innerHTML = `<span>${file.name}</span>`;
        if (reviewsResults[idx]) {
            const score = reviewsResults[idx].quality_score;
            tab.innerHTML += `<span class="badge ${score > 7 ? 'badge-green' : 'badge-red'}">${score}</span>`;
        }
        tab.onclick = () => loadTab(idx);
        container.appendChild(tab);
    });
    
    if (reviewsResults.length === filesToReview.length) {
        const summaryTab = document.createElement('div');
        summaryTab.className = `file-tab ${currentFileIndex === -2 ? 'active' : ''}`;
        summaryTab.innerHTML = `<span>Project Summary</span> <span class="badge badge-purple">★</span>`;
        summaryTab.onclick = () => loadProjectSummary();
        container.appendChild(summaryTab);
    }
}

function loadTab(idx) {
    currentFileIndex = idx;
    const file = filesToReview[idx];
    const reader = new FileReader();
    reader.onload = function(e) {
        editor.setValue(e.target.result);
        document.getElementById('current-file-name').innerText = file.name;
        renderTabs();
        if (reviewsResults[idx]) displayResults(reviewsResults[idx]);
        else resetResults();
    };
    reader.readAsText(file);
}

function resetResults() {
    document.getElementById('results-container').classList.add('hidden');
    document.getElementById('loading-overlay').classList.add('hidden');
}

// Review Logic
async function startReview() {
    if (filesToReview.length > 1) {
        startMultiReview();
        return;
    }

    const code = editor.getValue();
    const language = document.getElementById('language-select').value;
    
    // Auto-detect language if selected
    let detectedLang = language;
    if (language === 'auto') {
        const firstLines = code.split('\n').slice(0, 10).join('\n');
        if (firstLines.includes('import ') || firstLines.includes('def ')) detectedLang = 'python';
        else if (firstLines.includes('function') || firstLines.includes('const ')) detectedLang = 'javascript';
        else if (firstLines.includes('public class')) detectedLang = 'java';
        else if (firstLines.includes('package main')) detectedLang = 'go';
        else if (firstLines.includes('<!DOCTYPE html>')) detectedLang = 'html';
    }

    showLoading();
    
    try {
        const response = await fetch('/api/review', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, language: detectedLang })
        });
        const data = await response.json();
        currentReviewData = data;
        displayResults(data);
    } catch (error) {
        alert("Review failed. Check console.");
    } finally {
        hideLoading();
    }
}

async function startMultiReview() {
    showLoading();
    const payload = [];
    for (const file of filesToReview) {
        const content = await file.text();
        payload.push({ name: file.name, content, language: 'auto' });
    }

    try {
        const response = await fetch('/api/review-multiple', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ files: payload })
        });
        const data = await response.json();
        reviewsResults = data.reviews;
        projectSummary = data.projectSummary;
        
        loadTab(0);
        renderTabs();
    } catch (error) {
        alert("Multi-review failed.");
    } finally {
        hideLoading();
    }
}

function showLoading() {
    document.getElementById('loading-overlay').classList.remove('hidden');
    document.getElementById('results-container').classList.add('hidden');
    startMatrixLoader();
}

function hideLoading() {
    document.getElementById('loading-overlay').classList.add('hidden');
    document.getElementById('results-container').classList.remove('hidden');
}

function startMatrixLoader() {
    const loader = document.getElementById('matrix-loader');
    loader.innerText = "";
    const chars = "01ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const interval = setInterval(() => {
        if (document.getElementById('loading-overlay').classList.contains('hidden')) {
            clearInterval(interval);
            return;
        }
        let line = "";
        for (let i = 0; i < 20; i++) line += chars[Math.floor(Math.random() * chars.length)] + " ";
        loader.innerText = line + "\n" + loader.innerText.substring(0, 500);
    }, 50);
}

function displayResults(data) {
    if (!data) return;
    
    document.getElementById('results-container').classList.remove('hidden');
    document.getElementById('results-single-view').classList.remove('hidden');
    document.getElementById('results-project-view').classList.add('hidden');
    
    // Ensure data properties exist or use defaults
    const language = data.language || "Unknown";
    const score = typeof data.quality_score === 'number' ? data.quality_score : 0;
    const summary = data.summary || "No summary provided.";
    const bugs = Array.isArray(data.bugs) ? data.bugs : [];
    const security = Array.isArray(data.security) ? data.security : [];
    const timeComp = data.complexity?.time || "N/A";
    const spaceComp = data.complexity?.space || "N/A";
    const suggestions = Array.isArray(data.suggestions) ? data.suggestions : [];
    
    document.getElementById('res-language').innerText = language;
    
    // Animated Score
    animateScore(score);
    
    document.getElementById('res-summary').innerText = summary;
    
    const bugsList = document.getElementById('res-bugs');
    bugsList.innerHTML = bugs.length ? bugs.map(b => `<li>• ${b}</li>`).join('') : '<li class="text-[#00ff88]">No bugs found!</li>';
    
    const secList = document.getElementById('res-security');
    secList.innerHTML = security.length && security[0] !== "NONE" ? security.map(s => `<li>• ${s}</li>`).join('') : '<li class="text-[#00ff88]">No security issues found.</li>';
    
    document.getElementById('res-time').innerText = timeComp;
    document.getElementById('res-space').innerText = spaceComp;
    
    const sugList = document.getElementById('res-suggestions');
    sugList.innerHTML = suggestions.length ? suggestions.map(s => `<li>• ${s}</li>`).join('') : '<li>No suggestions.</li>';
    
    // Fix \n bug: replace literal \n strings with actual newlines
    fixedCode = (data.fixed_code || "").replace(/\\n/g, '\n');
    
    document.getElementById('chat-section').classList.remove('hidden');
    
    // Scroll to results
    document.getElementById('results-container').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function animateScore(targetScore) {
    const scoreEl = document.getElementById('res-score');
    const circle = document.getElementById('score-circle');
    let currentScore = 0;
    
    // Color coding
    let color = '#ff4444'; // Red
    if (targetScore >= 5 && targetScore <= 7) color = '#ffaa00'; // Amber
    else if (targetScore > 7) color = '#00ff88'; // Green
    
    circle.style.stroke = color;
    
    const interval = setInterval(() => {
        if (currentScore >= targetScore) {
            clearInterval(interval);
            return;
        }
        currentScore += 0.1;
        const displayScore = Math.min(currentScore, targetScore).toFixed(1);
        scoreEl.innerText = displayScore;
        circle.style.strokeDasharray = `${(currentScore / 10) * 100}, 100`;
    }, 20);
}

function loadProjectSummary() {
    currentFileIndex = -2;
    renderTabs();
    const data = projectSummary;
    document.getElementById('results-container').classList.remove('hidden');
    document.getElementById('results-single-view').classList.add('hidden');
    const projectView = document.getElementById('results-project-view');
    projectView.classList.remove('hidden');
    
    projectView.innerHTML = `
        <div class="bg-[#0f0f1a] border-l-4 border-[#7c3aed] rounded-r-xl p-6 shadow-xl slide-in">
            <h3 class="text-[#7c3aed] text-xs font-bold uppercase tracking-widest mb-4">Project Summary</h3>
            <div class="space-y-4">
                <div class="flex justify-between items-center">
                    <span class="text-sm">Avg Quality Score</span>
                    <span class="text-2xl font-bold text-[#00ff88]">${data.avgScore}/10</span>
                </div>
                <div class="flex justify-between items-center">
                    <span class="text-sm">Worst Performing File</span>
                    <span class="text-sm text-[#ff4444] font-mono">${data.worstFile}</span>
                </div>
            </div>
        </div>
        <div class="bg-[#0f0f1a] border-l-4 border-[#ff4444] rounded-r-xl p-6 shadow-xl slide-in">
            <h3 class="text-[#ff4444] text-xs font-bold uppercase tracking-widest mb-3">Critical Bugs Across Project</h3>
            <ul class="space-y-2 text-sm">${data.criticalBugs.map(b => `<li>• ${b}</li>`).join('')}</ul>
        </div>
        <div class="bg-[#0f0f1a] border-l-4 border-[#00ff88] rounded-r-xl p-6 shadow-xl slide-in">
            <h3 class="text-[#00ff88] text-xs font-bold uppercase tracking-widest mb-3">Top Project Suggestions</h3>
            <ul class="space-y-2 text-sm">${data.topSuggestions.map(s => `<li>• ${s}</li>`).join('')}</ul>
        </div>
    `;
}

// Compare Mode
function toggleCompare() {
    const section = document.getElementById('compare-section');
    section.classList.toggle('hidden');
    if (!section.classList.contains('hidden')) {
        renderDiff();
        section.scrollIntoView({ behavior: 'smooth' });
    }
}

function renderDiff() {
    const original = editor.getValue();
    const fixed = fixedCode || "";
    
    const originalContainer = document.getElementById('original-diff-container');
    const fixedContainer = document.getElementById('fixed-diff-container');
    
    if (!fixed) {
        originalContainer.innerHTML = '<div class="text-[#888899]">Original code loaded. Fixed version not available.</div>';
        fixedContainer.innerHTML = '<div class="text-[#888899]">No fixed code provided by AI.</div>';
        return;
    }
    
    // Simple line-by-line diff for visualization
    const origLines = original.split('\n');
    const fixedLines = fixed.split('\n');
    
    originalContainer.innerHTML = origLines.map(l => `<div class="${fixedLines.includes(l.trim()) ? '' : 'diff-removed'}">${escapeHtml(l) || '&nbsp;'}</div>`).join('');
    fixedContainer.innerHTML = fixedLines.map(l => `<div class="${origLines.includes(l.trim()) ? '' : 'diff-added'}">${escapeHtml(l) || '&nbsp;'}</div>`).join('');

    // Synchronized Scrolling
    originalContainer.onscroll = () => {
        fixedContainer.scrollTop = originalContainer.scrollTop;
    };
    fixedContainer.onscroll = () => {
        originalContainer.scrollTop = fixedContainer.scrollTop;
    };
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function copyFixedCode() {
    navigator.clipboard.writeText(fixedCode);
    
    // Feedback
    const feedback = document.getElementById('copy-feedback');
    const btn = document.getElementById('copy-btn');
    const fixedBox = document.getElementById('fixed-diff-container');
    
    feedback.classList.remove('hidden');
    btn.classList.add('opacity-50', 'pointer-events-none');
    fixedBox.classList.add('animate-green-flash');
    
    setTimeout(() => {
        feedback.classList.add('hidden');
        btn.classList.remove('opacity-50', 'pointer-events-none');
        fixedBox.classList.remove('animate-green-flash');
    }, 2000);
}

// Chat Logic
async function sendMessage() {
    const input = document.getElementById('chat-input');
    const question = input.value;
    if (!question) return;
    
    const messages = document.getElementById('chat-messages');
    
    // Add User Message
    messages.innerHTML += `
        <div class="flex justify-end animate-fade-in">
            <div class="bg-[#7c3aed] text-white p-4 rounded-2xl rounded-tr-none max-w-[80%] text-sm shadow-lg">
                ${question}
            </div>
        </div>
    `;
    
    chatHistory.push({ role: 'user', text: question });
    input.value = "";
    messages.scrollTop = messages.scrollHeight;

    // Add Loading Indicator
    const loadingId = 'ai-loading-' + Date.now();
    messages.innerHTML += `
        <div id="${loadingId}" class="flex justify-start animate-fade-in">
            <div class="bg-[#1a1a2e] border border-[#00ff88]/20 p-4 rounded-2xl rounded-tl-none max-w-[80%] text-sm flex items-center gap-2">
                <span class="text-[#00ff88]">AI is thinking</span>
                <span class="flex gap-1">
                    <span class="w-1 h-1 bg-[#00ff88] rounded-full animate-blink"></span>
                    <span class="w-1 h-1 bg-[#00ff88] rounded-full animate-blink" style="animation-delay: 0.2s"></span>
                    <span class="w-1 h-1 bg-[#00ff88] rounded-full animate-blink" style="animation-delay: 0.4s"></span>
                </span>
            </div>
        </div>
    `;
    messages.scrollTop = messages.scrollHeight;

    try {
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                code: editor.getValue(), 
                question,
                history: chatHistory.slice(-5) // Send last 5 messages for context
            })
        });
        const data = await response.json();
        
        // Remove loading
        document.getElementById(loadingId).remove();
        
        // Add AI Response
        messages.innerHTML += `
            <div class="flex justify-start animate-fade-in">
                <div class="bg-[#1a1a2e] border border-[#00ff88]/20 p-4 rounded-2xl rounded-tl-none max-w-[80%] text-sm">
                    ${data.answer}
                </div>
            </div>
        `;
        chatHistory.push({ role: 'ai', text: data.answer });
        messages.scrollTop = messages.scrollHeight;
    } catch (error) {
        document.getElementById(loadingId).innerHTML = `<span class="text-[#ff4444]">Error: Chat failed.</span>`;
    }
}

// History
async function toggleHistory() {
    const panel = document.getElementById('history-panel');
    panel.classList.toggle('translate-x-full');
    if (!panel.classList.contains('translate-x-full')) {
        try {
            const response = await fetch('/api/history');
            const history = await response.json();
            const list = document.getElementById('history-list');
            if (history.length === 0) {
                list.innerHTML = '<div class="text-center text-[#888899] py-10">No reviews yet.</div>';
                return;
            }
            list.innerHTML = history.map(item => `
                <div class="bg-[#1a1a2e] border border-[#00ff88]/10 p-4 rounded-xl cursor-pointer hover:border-[#00ff88]/40 transition-all" onclick="loadHistoryItem(${item.id})">
                    <div class="flex justify-between items-center mb-2">
                        <span class="text-[10px] text-[#00ff88] font-bold uppercase">${item.language}</span>
                        <span class="badge ${item.quality_score > 7 ? 'badge-green' : 'badge-red'}">${item.quality_score}/10</span>
                    </div>
                    <p class="text-[10px] text-[#888899] mb-2">${new Date(item.timestamp).toLocaleString()}</p>
                    <p class="text-xs text-[#e0e0e0] line-clamp-2">${item.summary}</p>
                </div>
            `).join('');
        } catch (err) {
            console.error(err);
        }
    }
}

async function loadHistoryItem(id) {
    try {
        const response = await fetch('/api/history');
        const history = await response.json();
        const item = history.find(i => i.id === id);
        if (item) {
            editor.setValue(item.original_code);
            document.getElementById('language-select').value = item.language.toLowerCase();
            monaco.editor.setModelLanguage(editor.getModel(), item.language.toLowerCase());
            
            if (item.full_review) {
                try {
                    const parsed = JSON.parse(item.full_review);
                    currentReviewData = parsed;
                    displayResults(parsed);
                } catch (e) {
                    console.error("Failed to parse history item full_review", e);
                }
            }
            toggleHistory();
            scrollToEditor();
        }
    } catch (err) {
        console.error(err);
    }
}

function runDemo() {
    const demoCode = `function calculateTotal(items) {
  var total = 0;
  for (var i = 0; i <= items.length; i++) {
    total += items[i].price;
  }
  if (total = 100) {
    console.log("Discount applied");
  }
  return total;
}`;
    if (!editorReady) {
        alert("Editor is still loading, please wait...");
        return;
    }
    editor.setValue(demoCode);
    document.getElementById('language-select').value = 'javascript';
    monaco.editor.setModelLanguage(editor.getModel(), 'javascript');
    scrollToEditor('review-btn');
    setTimeout(() => {
        startReview();
    }, 800);
}

// GitHub Fetch
async function fetchGitHub() {
    const url = document.getElementById('github-url').value;
    if (!url) return;
    try {
        const response = await fetch(`/api/fetch-github?url=${encodeURIComponent(url)}`);
        const data = await response.json();
        editor.setValue(data.code);
        document.getElementById('current-file-name').innerText = url.split('/').pop();
    } catch (error) {
        alert("Failed to fetch GitHub URL.");
    }
}

function downloadCode() {
    const code = editor.getValue();
    const filename = document.getElementById('current-file-name').innerText || 'code.txt';
    const blob = new Blob([code], { type: 'text/plain' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
}

// PDF Export
async function exportPDF() {
    const isProjectSummary = currentFileIndex === -2;
    const reviewData = isProjectSummary ? projectSummary : currentReviewData;
    
    if (!reviewData) return;
    
    const response = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewData, isProjectSummary })
    });
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = isProjectSummary ? 'project-review-summary.pdf' : 'code-review.pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
}

// GitHub Auth
function scrollToEditor(targetId = 'editor-section') {
    const el = document.getElementById(targetId);
    if (!el) return;
    
    const offset = 100; // Account for fixed navbar
    const elementPosition = el.getBoundingClientRect().top + window.pageYOffset;
    const offsetPosition = elementPosition - offset;

    window.scrollTo({
        top: offsetPosition,
        behavior: 'smooth'
    });
}
