import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { GoogleGenAI, Type } from "@google/genai";
import Database from "better-sqlite3";
import PDFDocument from "pdfkit";
import axios from "axios";
import fs from "fs";
import crypto from "crypto";
import JSZip from "jszip";

// Initialize Database
const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || "./";
if (dataDir !== "./" && !fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
const dbPath = path.join(dataDir, "reviews.db");
const db = new Database(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    language TEXT,
    original_code TEXT,
    quality_score INTEGER,
    summary TEXT,
    full_review TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Simple session store for demo (use real session in production)
const sessions: Record<string, any> = {};

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '10mb' }));

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/api/download-project", async (req, res) => {
    try {
      const zip = new JSZip();
      
      const addFilesToZip = (dir: string, zipFolder: JSZip) => {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          const filePath = path.join(dir, file);
          const stats = fs.statSync(filePath);
          
          if (stats.isDirectory()) {
            if (file === "node_modules" || file === ".git" || file === "dist" || file === ".next") continue;
            const folder = zipFolder.folder(file);
            if (folder) addFilesToZip(filePath, folder);
          } else {
            const content = fs.readFileSync(filePath);
            zipFolder.file(file, content);
          }
        }
      };

      addFilesToZip(process.cwd(), zip);
      
      const content = await zip.generateAsync({ type: "nodebuffer" });
      
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", "attachment; filename=project.zip");
      res.send(content);
    } catch (error) {
      console.error("Zip Error:", error);
      res.status(500).json({ error: "Failed to generate zip" });
    }
  });

  // GitHub OAuth Routes
  app.get("/api/auth/github/url", (req, res) => {
    const clientId = process.env.GITHUB_CLIENT_ID;
    const appUrl = process.env.APP_URL;

    console.log("GitHub OAuth Request - Client ID present:", !!clientId, "APP_URL present:", !!appUrl);

    if (!clientId) {
      return res.status(500).json({ error: "GITHUB_CLIENT_ID not configured" });
    }
    if (!appUrl) {
      return res.status(500).json({ error: "APP_URL not configured" });
    }

    const redirectUri = `${appUrl}/api/auth/github/callback`;
    const state = crypto.randomBytes(16).toString("hex");
    const url = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=user,repo&state=${state}`;
    res.json({ url });
  });

  app.get("/api/auth/github/callback", async (req, res) => {
    const { code } = req.query;
    const clientId = process.env.GITHUB_CLIENT_ID;
    const clientSecret = process.env.GITHUB_CLIENT_SECRET;

    try {
      const response = await axios.post("https://github.com/login/oauth/access_token", {
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }, {
        headers: { Accept: "application/json" }
      });

      const { access_token } = response.data;
      
      // Fetch user info
      const userResponse = await axios.get("https://api.github.com/user", {
        headers: { Authorization: `token ${access_token}` }
      });

      res.send(`
        <html>
          <body>
            <script>
              if (window.opener) {
                window.opener.postMessage({ 
                  type: 'OAUTH_AUTH_SUCCESS', 
                  user: ${JSON.stringify(userResponse.data)} 
                }, '*');
                window.close();
              } else {
                window.location.href = '/';
              }
            </script>
            <p>Authentication successful. Closing window...</p>
          </body>
        </html>
      `);
    } catch (error) {
      console.error("GitHub OAuth Error:", error);
      res.status(500).send("Authentication failed");
    }
  });

  const apiKey = process.env.MY_GEMINI_KEY || process.env.GEMINI_API_KEY || "";
  if (!apiKey) {
    console.error("CRITICAL: No API key found. Please set MY_GEMINI_KEY or GEMINI_API_KEY in Secrets.");
  }
  const ai = new GoogleGenAI({ apiKey });

  async function callGeminiWithRetry(params: any, retries = 3, delay = 2000) {
    for (let i = 0; i < retries; i++) {
      try {
        return await ai.models.generateContent(params);
      } catch (error: any) {
        const isQuotaError = error?.message?.includes("429") || error?.message?.includes("RESOURCE_EXHAUSTED");
        if (isQuotaError && i < retries - 1) {
          console.log(`Quota exceeded, retrying in ${delay}ms... (Attempt ${i + 1}/${retries})`);
          await new Promise(resolve => setTimeout(resolve, delay));
          delay *= 2; // Exponential backoff
          continue;
        }
        throw error;
      }
    }
  }

  const reviewSchema = {
    type: Type.OBJECT,
    properties: {
      language: { type: Type.STRING },
      bugs: { type: Type.ARRAY, items: { type: Type.STRING } },
      quality_score: { type: Type.INTEGER },
      security: { type: Type.ARRAY, items: { type: Type.STRING } },
      complexity: {
        type: Type.OBJECT,
        properties: {
          time: { type: Type.STRING },
          space: { type: Type.STRING }
        },
        required: ["time", "space"]
      },
      suggestions: { type: Type.ARRAY, items: { type: Type.STRING } },
      fixed_code: { type: Type.STRING },
      summary: { type: Type.STRING }
    },
    required: ["language", "bugs", "quality_score", "security", "complexity", "suggestions", "fixed_code", "summary"]
  };

  // API Routes
  app.post("/api/review", async (req, res) => {
    const { code, language } = req.body;
    if (!code) return res.status(400).json({ error: "No code provided" });

    try {
      const prompt = `You are a professional code reviewer. Analyze the following ${language === 'auto' ? 'code (please detect the language)' : language} code and provide a detailed review in JSON format.
      
      The JSON MUST follow this schema exactly:
      {
        "language": "string (the detected language)",
        "bugs": ["string (list of bugs found)"],
        "quality_score": number (0-10),
        "security": ["string (list of security issues)"],
        "complexity": {
          "time": "string (e.g. O(n))",
          "space": "string (e.g. O(1))"
        },
        "suggestions": ["string (list of improvements)"],
        "fixed_code": "string (the complete fixed version of the code)",
        "summary": "string (a 3-sentence summary of the review)"
      }

      CODE TO ANALYZE:
      \`\`\`${language === 'auto' ? '' : language}
      ${code}
      \`\`\``;

      const result = await callGeminiWithRetry({
        model: "gemini-3-flash-preview",
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: {
          responseMimeType: "application/json",
          responseSchema: reviewSchema
        }
      });

      const responseText = result?.text;
      console.log("AI Response received, length:", responseText?.length);
      
      if (!responseText) throw new Error("Empty response from AI");
      
      let parsed;
      try {
        parsed = JSON.parse(responseText);
      } catch (parseError) {
        console.error("JSON Parse Error. Raw text:", responseText);
        // Try to extract JSON if it's wrapped in markdown
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[0]);
        } else {
          throw new Error("Invalid JSON response from AI");
        }
      }

      // Ensure all required fields exist to prevent frontend "Unknown" issues
      parsed.language = parsed.language || language || "Unknown";
      parsed.bugs = Array.isArray(parsed.bugs) ? parsed.bugs : [];
      parsed.quality_score = typeof parsed.quality_score === 'number' ? parsed.quality_score : 0;
      parsed.security = Array.isArray(parsed.security) ? parsed.security : [];
      parsed.complexity = parsed.complexity || { time: "N/A", space: "N/A" };
      parsed.suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
      parsed.fixed_code = parsed.fixed_code || code;
      parsed.summary = parsed.summary || "Analysis complete. No major issues found.";

      console.log("Final parsed object for frontend:", JSON.stringify(parsed));

      // Save to history
      try {
        const stmt = db.prepare("INSERT INTO reviews (language, original_code, quality_score, summary, full_review) VALUES (?, ?, ?, ?, ?)");
        stmt.run(parsed.language || language || "Unknown", code, parsed.quality_score || 0, parsed.summary || "No summary", responseText);
      } catch (dbErr) {
        console.error("Database Error:", dbErr);
      }

      res.json(parsed);
    } catch (error) {
      console.error("Review Error:", error);
      res.status(500).json({ error: "Failed to process review: " + (error instanceof Error ? error.message : "Unknown error") });
    }
  });

  app.post("/api/review-multiple", async (req, res) => {
    const { files } = req.body;
    if (!files || !Array.isArray(files)) return res.status(400).json({ error: "Invalid files" });

    try {
      const reviews = [];
      let totalScore = 0;

      for (const file of files) {
        const prompt = `Analyze this ${file.language || 'auto-detected'} code for file "${file.name}" for bugs, security, complexity, and quality.
Code:
${file.content}`;

        const result = await callGeminiWithRetry({
          model: "gemini-3-flash-preview",
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          config: {
            responseMimeType: "application/json",
            responseSchema: reviewSchema
          }
        });
        const responseText = result?.text || "{}";
        let parsed;
        try {
          parsed = JSON.parse(responseText);
        } catch (parseError) {
          const jsonMatch = responseText.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            try {
              parsed = JSON.parse(jsonMatch[0]);
            } catch (e) {
              parsed = {};
            }
          } else {
            parsed = {};
          }
        }
        
        parsed.filename = file.name;
        reviews.push(parsed);
        totalScore += parsed.quality_score || 0;
      }

      const avgScore = files.length > 0 ? Math.round(totalScore / files.length) : 0;
      const projectSummary = {
        avgScore,
        criticalBugs: reviews.flatMap(r => r.bugs).slice(0, 5),
        topSuggestions: reviews.flatMap(r => r.suggestions).slice(0, 5),
        worstFile: reviews.length > 0 ? reviews.reduce((prev, curr) => (prev.quality_score < curr.quality_score ? prev : curr)).filename : "N/A"
      };

      res.json({ reviews, projectSummary });
    } catch (error) {
      console.error("Multi-Review Error:", error);
      res.status(500).json({ error: "Failed to process multi-file review" });
    }
  });

  app.post("/api/chat", async (req, res) => {
    const { code, question, history = [] } = req.body;
    try {
      const chatHistory = history.map((msg: any) => ({
        role: msg.role === 'user' ? 'user' : 'model',
        parts: [{ text: msg.text }]
      }));

      const systemInstruction = "You are an AI Code Reviewer assistant. You have access to the code being reviewed. Answer questions about the code precisely, helpfully, and concisely. If the user asks for changes, explain them and provide code snippets if necessary.";
      
      const prompt = `Code Context:\n\`\`\`\n${code}\n\`\`\`\n\nUser Question: ${question}`;
      
      const result = await callGeminiWithRetry({
        model: "gemini-3-flash-preview",
        contents: [...chatHistory, { role: "user", parts: [{ text: prompt }] }],
        config: {
          systemInstruction
        }
      });
      res.json({ answer: result?.text });
    } catch (error) {
      console.error("Chat Error:", error);
      res.status(500).json({ error: "Chat failed" });
    }
  });

  app.get("/api/history", (req, res) => {
    try {
      const rows = db.prepare("SELECT * FROM reviews ORDER BY timestamp DESC LIMIT 10").all();
      res.json(rows);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch history" });
    }
  });

  app.post("/api/export", async (req, res) => {
    const { reviewData, isProjectSummary } = req.body;
    try {
      const doc = new PDFDocument();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename=code-review.pdf');
      doc.pipe(res);

      if (isProjectSummary) {
        doc.fontSize(25).text('AI Project Review Summary', { align: 'center' });
        doc.moveDown();
        doc.fontSize(14).text(`Average Quality Score: ${reviewData.avgScore}/10`);
        doc.text(`Worst Performing File: ${reviewData.worstFile}`);
        doc.moveDown();
        doc.fontSize(16).text('Critical Bugs Across Project:');
        reviewData.criticalBugs.forEach((bug: string) => doc.fontSize(12).text(`• ${bug}`));
        doc.moveDown();
        doc.fontSize(16).text('Top Project Suggestions:');
        reviewData.topSuggestions.forEach((sug: string) => doc.fontSize(12).text(`• ${sug}`));
      } else {
        doc.fontSize(25).text('AI Code Review Report', { align: 'center' });
        doc.moveDown();
        doc.fontSize(14).text(`Language: ${reviewData.language}`);
        doc.text(`Quality Score: ${reviewData.quality_score}/10`);
        doc.moveDown();
        doc.fontSize(16).text('Summary:');
        doc.fontSize(12).text(reviewData.summary);
        doc.moveDown();
        doc.fontSize(16).text('Bugs:');
        reviewData.bugs.forEach((bug: string) => doc.fontSize(12).text(`• ${bug}`));
        doc.moveDown();
        doc.fontSize(16).text('Security:');
        reviewData.security.forEach((sec: string) => doc.fontSize(12).text(`• ${sec}`));
        doc.moveDown();
        doc.fontSize(16).text('Complexity:');
        doc.fontSize(12).text(`Time: ${reviewData.complexity?.time || 'N/A'}`);
        doc.text(`Space: ${reviewData.complexity?.space || 'N/A'}`);
        doc.moveDown();
        doc.fontSize(16).text('Suggestions:');
        reviewData.suggestions.forEach((sug: string) => doc.fontSize(12).text(`• ${sug}`));
      }
      
      doc.end();
    } catch (error) {
      console.error("PDF Export Error:", error);
      res.status(500).send("Failed to generate PDF");
    }
  });

  app.get("/api/fetch-github", async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: "URL required" });
    try {
      const response = await axios.get(url as string);
      res.json({ code: response.data });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch GitHub URL" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  if (process.env.NODE_ENV !== "production" && !process.env.VERCEL) {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  }

  return app;
}

function parseGeminiResponse(text: string) {
  const sections: any = {
    language: "",
    bugs: [],
    quality_score: 0,
    security: [],
    complexity: { time: "", space: "" },
    suggestions: [],
    fixed_code: "",
    summary: ""
  };

  const lines = text.split('\n');
  let currentSection = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith("LANGUAGE:")) {
      sections.language = line.replace("LANGUAGE:", "").trim();
      currentSection = "";
    } else if (line.startsWith("BUGS:")) {
      currentSection = "bugs";
    } else if (line.startsWith("QUALITY_SCORE:")) {
      const scoreStr = line.replace("QUALITY_SCORE:", "").trim();
      sections.quality_score = parseInt(scoreStr) || 0;
      currentSection = "";
    } else if (line.startsWith("SECURITY:")) {
      currentSection = "security";
    } else if (line.startsWith("COMPLEXITY:")) {
      currentSection = "complexity";
    } else if (line.startsWith("SUGGESTIONS:")) {
      currentSection = "suggestions";
    } else if (line.startsWith("FIXED_CODE:")) {
      currentSection = "fixed_code";
      let codeLines = [];
      i++;
      // Look for code block start
      while (i < lines.length && !lines[i].includes("```")) {
        i++;
      }
      if (i < lines.length && lines[i].includes("```")) {
        i++; // skip opening ```
        while (i < lines.length && !lines[i].includes("```")) {
          codeLines.push(lines[i]);
          i++;
        }
      }
      sections.fixed_code = codeLines.join('\n').trim();
      currentSection = "";
    } else if (line.startsWith("SUMMARY:")) {
      currentSection = "summary";
    } else if (currentSection) {
      if (currentSection === "bugs" && line.startsWith("-")) {
        const bug = line.replace("-", "").trim();
        if (bug.toUpperCase() !== "NONE") sections.bugs.push(bug);
      } else if (currentSection === "security" && line.startsWith("-")) {
        const sec = line.replace("-", "").trim();
        if (sec.toUpperCase() !== "NONE") sections.security.push(sec);
      } else if (currentSection === "suggestions" && line.startsWith("-")) {
        sections.suggestions.push(line.replace("-", "").trim());
      } else if (currentSection === "complexity") {
        if (line.toLowerCase().includes("time:")) sections.complexity.time = line.split(":")[1]?.trim() || line;
        if (line.toLowerCase().includes("space:")) sections.complexity.space = line.split(":")[1]?.trim() || line;
      } else if (currentSection === "summary") {
        sections.summary += line + " ";
      }
    }
  }
  sections.summary = sections.summary.trim();
  return sections;
}

const appPromise = startServer();
export default appPromise;
