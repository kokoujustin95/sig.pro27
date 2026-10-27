const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');

const app = express();
const port = process.env.PORT || 3000;
const databaseUrl = process.env.DATABASE_URL || '';
const pool = databaseUrl ? new Pool({
  connectionString: databaseUrl,
  ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? false : { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 5
}) : null;
if (!databaseUrl) console.error('DATABASE_URL manquant : le site démarre en mode dégradé, ajoute la base PostgreSQL dans Render.');
if (pool) pool.on('error', (err) => console.error('Erreur inattendue du pool PostgreSQL:', err.message));
app.disable('x-powered-by');
app.use(express.json({ limit: '20mb' }));
// Mode maintenance activable dans Render avec MAINTENANCE_MODE=true.
// La route de santé reste accessible pour permettre le contrôle du service.
app.use((req, res, next) => {
  const maintenance = String(process.env.MAINTENANCE_MODE || '').toLowerCase() === 'true';
  if (!maintenance || req.path === '/api/health') return next();
  res.status(503).set('Retry-After', '300').sendFile(path.join(__dirname, '404.html'));
});
app.use(express.static(path.join(__dirname), { index: false, setHeaders(res, filePath) { if (filePath.toLowerCase().endsWith('.pdf')) { res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Cache-Control', 'public, max-age=300'); } } }));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
// Alias stables pour le guide : les liens fonctionnent même depuis une route interne.
const guidePath = path.join(__dirname, 'Guide_utilisateur_GS_SIGMA.pdf');
app.get(['/Guide_utilisateur_GS_SIGMA.pdf', '/guide-utilisateur.pdf', '/guide.pdf'], (_req, res) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Disposition', 'inline; filename="Guide_utilisateur_GS_SIGMA.pdf"');
  res.set('Cache-Control', 'no-store');
  res.type('application/pdf');
  res.sendFile(guidePath, (err) => {
    if (err && !res.headersSent) res.status(err.statusCode || 404).type('text').send('Guide PDF introuvable. Vérifiez que Guide_utilisateur_GS_SIGMA.pdf est à la racine du projet Render.');
  });
});


// Confirmation de connexion par code à usage unique envoyé par e-mail.
const loginCodes = new Map();
const sendWindows = new Map();
function smtpConfigured(){return !!(process.env.SMTP_USER && process.env.SMTP_PASS && process.env.SMTP_FROM);}
function normalizeEmail(v){return String(v||'').trim().toLowerCase();}
app.post('/api/send-login-code', async (req,res)=>{
  const email=normalizeEmail(req.body && req.body.email);
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({error:'Adresse e-mail invalide.'});
  if(!smtpConfigured()) return res.status(503).json({error:'Le service e-mail n’est pas configuré : ajoute SMTP_USER, SMTP_PASS et SMTP_FROM dans les variables d’environnement Render. Pour Gmail, SMTP_HOST=smtp.gmail.com et SMTP_PORT=587.'});
  const now=Date.now(),last=sendWindows.get(email)||0;
  if(now-last<60000) return res.status(429).json({error:'Attends une minute avant de demander un nouveau code.'});
  const code=String(Math.floor(100000+Math.random()*900000));
  const expiresAt=now+10*60*1000;
  try{
    const transporter=nodemailer.createTransport({host:process.env.SMTP_HOST||'smtp.gmail.com',port:Number(process.env.SMTP_PORT||587),secure:String(process.env.SMTP_SECURE||'false').toLowerCase()==='true',auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}});
    await transporter.sendMail({from:process.env.SMTP_FROM,to:email,subject:'Code de confirmation — GROUPE SCIENTIFIQUE SIGMA',text:`Ton code de confirmation de connexion est : ${code}\n\nCe code expire dans 10 minutes. Si tu n’es pas à l’origine de cette demande, ignore ce message.`,html:`<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px;border:1px solid #dce8ec;border-radius:14px"><h2 style="color:#145766">GROUPE SCIENTIFIQUE SIGMA</h2><p>Voici ton code de confirmation de connexion :</p><p style="font-size:32px;font-weight:bold;letter-spacing:8px;color:#145766">${code}</p><p>Ce code expire dans <b>10 minutes</b>. Ne le partage avec personne.</p></div>`});
    loginCodes.set(email,{code,expiresAt,attempts:0});sendWindows.set(email,now);
    res.set('Cache-Control','no-store').json({ok:true,message:'Code envoyé.'});
  }catch(e){console.error('Envoi du code e-mail impossible:',e.message);res.status(502).json({error:'Impossible d’envoyer le code. Vérifie la configuration SMTP et l’adresse e-mail.'});}
});
app.post('/api/verify-login-code',(req,res)=>{
  const email=normalizeEmail(req.body && req.body.email),code=String(req.body && req.body.code||'').trim(),entry=loginCodes.get(email);
  if(!entry||Date.now()>entry.expiresAt){loginCodes.delete(email);return res.status(400).json({error:'Code expiré ou inexistant. Demande un nouveau code.'});}
  entry.attempts++;
  if(entry.attempts>5){loginCodes.delete(email);return res.status(429).json({error:'Trop de tentatives. Demande un nouveau code.'});}
  if(code!==entry.code)return res.status(400).json({error:'Code incorrect. Vérifie le message reçu.'});
  loginCodes.delete(email);res.set('Cache-Control','no-store').json({ok:true,verified:true});
});

async function init() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sigma_shared_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}
app.get('/api/health', async (_req, res) => {
  if (!pool) return res.status(503).set('Cache-Control', 'no-store').json({ ok: false, service: 'GS SIGMA', database: 'unconfigured', message: 'DATABASE_URL est absente dans les variables d’environnement Render.' });
  try {
    await pool.query('SELECT 1');
    res.set('Cache-Control', 'no-store').json({ ok: true, service: 'GS SIGMA', database: 'connected' });
  } catch (e) {
    console.error('Contrôle PostgreSQL échoué:', e.message);
    res.status(503).json({ ok: false, service: 'GS SIGMA', database: 'unavailable', message: 'Connexion PostgreSQL indisponible. Vérifiez DATABASE_URL et le statut de la base Render.' });
  }
});
app.get('/api/shared-db', async (_req, res) => {
  if (!pool) return res.status(503).json({ error: 'Base PostgreSQL non configurée : ajoute DATABASE_URL dans Render.' });
  try {
    const result = await pool.query('SELECT payload, updated_at FROM sigma_shared_state WHERE id=1');
    res.set('Cache-Control', 'no-store');
    res.json(result.rows.length ? result.rows[0].payload : null);
  } catch (e) { console.error('Lecture /api/shared-db échouée:', e.message); res.status(500).json({ error: 'Lecture PostgreSQL impossible. Vérifiez la base Render et DATABASE_URL.' }); }
});
app.put('/api/shared-db', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Base PostgreSQL non configurée : ajoute DATABASE_URL dans Render.' });
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Format de base invalide.' });
    }
    const raw = JSON.stringify(req.body);
    if (Buffer.byteLength(raw, 'utf8') > 15 * 1024 * 1024) {
      return res.status(413).json({ error: 'La base dépasse la taille autorisée (15 Mo).' });
    }
    await pool.query(
      `INSERT INTO sigma_shared_state(id,payload,updated_at) VALUES(1,$1::jsonb,NOW())
       ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload, updated_at=NOW()`,
      [raw]
    );
    res.json({ ok: true, savedAt: new Date().toISOString() });
  } catch (e) { console.error('Écriture /api/shared-db échouée:', e.message); res.status(500).json({ error: 'Enregistrement PostgreSQL impossible. Vérifiez la base Render et DATABASE_URL.' }); }
});
app.get('/404', (_req, res) => res.status(404).sendFile(path.join(__dirname, '404.html')));
app.get('*', (_req, res) => res.status(404).sendFile(path.join(__dirname, '404.html'), (err) => {
  if (err && !res.headersSent) res.status(404).type('text').send('Page introuvable (404).');
}));
init().catch(e => { console.error('Initialisation PostgreSQL impossible :', e.message); }).finally(() => {
  app.listen(port, () => console.log(`GS SIGMA prêt sur le port ${port}`));
});
