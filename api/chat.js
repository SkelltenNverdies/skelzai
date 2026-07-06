export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    
    try {
        let body;
        try {
            body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        } catch (e) {
            return res.status(400).json({ error: 'Invalid JSON' });
        }
        
        const { provider = 'qwen', model, messages } = body;
        if (!model || !messages || !Array.isArray(messages)) {
            return res.status(400).json({ error: 'Invalid request' });
        }
        
        const systemPrompt = {
            role: 'system',
            content: `Kamu adalah SkelzAI, asisten AI SENIOR SOFTWARE ENGINEER berbahasa Indonesia.
Pencipta: Gabriel Arjun Pangestu (masterpiece).
ATURAN:
1. SELALU jawab dalam BAHASA INDONESIA
2. Kode HARUS LENGKAP 100% - TIDAK BOLEH ada "..." atau "// TODO"
3. Tulis SETIAP BARIS kode dari awal sampai akhir
4. WAJIB include error handling (try-catch), type hints, comments
5. Gunakan best practices modern
6. Jika diminta website/app, berikan struktur folder lengkap
7. Selalu tanyakan klarifikasi jika requirement ambigu
FORMAT OUTPUT:
1. Penjelasan singkat
2. KODE LENGKAP dalam code block
3. Cara menjalankan
4. Tips & best practices`
        };
        
        const finalMessages = [systemPrompt, ...messages];
        let url, headers, requestBody, timeout;
        
        if (provider === 'qwen') {
            if (!process.env.QWEN_API_KEY) return res.status(500).json({ error: 'QWEN_API_KEY not set' });
            url = 'https://ws-3cudsfbi2d76ndhg.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions';
            headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.QWEN_API_KEY}`, 'X-DashScope-WorkSpace': 'ws-3cudsfbi2d76ndhg' };
            requestBody = { model, messages: finalMessages, stream: false, max_tokens: 4096, temperature: 0.7 };
            timeout = 60000;
        } else if (provider === 'groq') {
            if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: 'GROQ_API_KEY not set' });
            url = 'https://api.groq.com/openai/v1/chat/completions';
            headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` };
            requestBody = { model, messages: finalMessages, stream: false, max_tokens: 5000, temperature: 0.7 };
            timeout = 60000;
        } else if (provider === 'bluesminds') {
            if (!process.env.BLUEMINDS_API_KEY) return res.status(500).json({ error: 'BLUEMINDS_API_KEY not set' });
            url = 'https://api.bluesminds.com/v1/chat/completions';
            headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.BLUEMINDS_API_KEY}` };
            requestBody = { model: model || 'glm-4.6', messages: finalMessages, stream: false, max_tokens: 2048, temperature: 0.7 };
            timeout = 30000;
        } else {
            return res.status(400).json({ error: 'Unknown provider' });
        }
        
        let response, lastError;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const controller = new AbortController();
                const tid = setTimeout(() => controller.abort(), timeout);
                response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(requestBody), signal: controller.signal });
                clearTimeout(tid);
                if (response.status === 429) { await new Promise(r => setTimeout(r, (attempt + 1) * 5000)); continue; }
                if (response.status === 504) { continue; }
                break;
            } catch (err) {
                lastError = err.message;
                if (attempt < 1) await new Promise(r => setTimeout(r, (attempt + 1) * 3000));
            }
        }
        
        if (!response || !response.ok) {
            const status = response ? response.status : 500;
            const errText = response ? await response.text() : lastError;
            if (status === 504 && process.env.QWEN_API_KEY) {
                try {
                    const fr = await fetch('https://ws-3cudsfbi2d76ndhg.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.QWEN_API_KEY}`, 'X-DashScope-WorkSpace': 'ws-3cudsfbi2d76ndhg' },
                        body: JSON.stringify({ model: 'qwen-turbo', messages: finalMessages, stream: false, max_tokens: 4096, temperature: 0.7 })
                    });
                    if (fr.ok) return res.status(200).json(await fr.json());
                } catch (e) {}
            }
            return res.status(status).json({ error: `${provider} error ${status}: ${(errText || '').substring(0, 200)}` });
        }
        
        return res.status(200).json(await response.json());
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}