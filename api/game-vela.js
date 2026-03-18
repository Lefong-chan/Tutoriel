// api/game-vela.js
// Fitantanana ny état ny lalao Fanorona ao amin'ny Firebase RTDB
// AUTO-OK : rehefa manao hetsika iray ny player dia nalefa avy hatrany ny OK (stop-move na make-move tsy misy continuation)
// Ny hetsika maromaro (multi-capture) dia voasoratra eto fa mbola tsy ampiasaina

import admin from "firebase-admin";

if (!process.env.FIREBASE_KEY) throw new Error("FIREBASE_KEY not set");
const allowedOrigin = process.env.ALLOWED_ORIGIN;

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
  }
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
}

const rtdb       = admin.database();
const gamesRef   = rtdb.ref("games");
const invitesRef = rtdb.ref("gameInvites");

async function rtdbGet(ref) {
  const snap = await ref.once("value");
  return snap.exists() ? snap.val() : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Credentials", true);
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed." });
  if (allowedOrigin && req.headers.origin !== allowedOrigin)
    return res.status(403).json({ error: "Forbidden." });

  const { action, ...payload } = req.body;
  if (!action) return res.status(400).json({ error: "Action required." });

  try {
    switch (action) {
      case "get-state":  return await handleGetState(payload, res);
      case "make-move":  return await handleMakeMove(payload, res);
      case "stop-move":  return await handleStopMove(payload, res);
      default: return res.status(400).json({ error: "Invalid action." });
    }
  } catch (err) {
    console.error(`GAME-VELA API ERROR [${action}]:`, err);
    return res.status(500).json({ error: "An unexpected server error occurred." });
  }
}

// ── Mamerina ny état rehetra ny lalao ──────────────────────────────────────
// Body: { uid, gameId }
async function handleGetState(body, res) {
  const { uid, gameId } = body;
  if (!uid || !gameId) return res.status(400).json({ error: "uid and gameId required." });

  const game = await rtdbGet(gamesRef.child(gameId));
  if (!game) return res.status(404).json({ error: "Game not found." });
  if (game.senderUid !== uid && game.receiverUid !== uid)
    return res.status(403).json({ error: "Not authorized." });

  return res.status(200).json({ success: true, game });
}

// ── Manao dingana (AUTO-OK) ─────────────────────────────────────────────────
// Body: { uid, gameId, origin, target, capturedSpots, dir }
//
// AUTO-OK: Rehefa manao hetsika iray ny player dia :
//   - Raha tsy misy continuation azo (tsy misy capture hafa) → mifindra tour avy hatrany
//   - Raha misy continuation (multi-capture) → mbola tsy ampiasaina izany (voasoratra fa tsy active)
//     → ny server dia mihevitra fa AUTO-OK foana (mifindra tour)
//
// Ny lojika multi-capture (canContinue) dia voasoratra eto fa DISABLED mba ho AUTO-OK foana.
// Rehefa hampiana ilay feature multi-capture dia ovana fotsiny ny "AUTO_OK_ALWAYS = false".
async function handleMakeMove(body, res) {
  const { uid, gameId, origin, target, capturedSpots = [], dir } = body;
  if (!uid || !gameId || !origin || !target)
    return res.status(400).json({ error: "uid, gameId, origin, target required." });

  const gameRef = gamesRef.child(gameId);
  const game    = await rtdbGet(gameRef);
  if (!game)                        return res.status(404).json({ error: "Game not found." });
  if (game.senderUid !== uid && game.receiverUid !== uid)
                                    return res.status(403).json({ error: "Not authorized." });

  const myColor = game.senderUid === uid ? "maintso" : "mena";
  if (game.turn !== myColor)        return res.status(400).json({ error: "Tsy anjaranao." });

  // Raha misy movingPiece, ny origin dia tsy maintsy izany movingPiece izany
  if (game.movingPiece && game.movingPiece !== origin)
    return res.status(400).json({ error: "Pio hafa tsy azo hetsehina izao." });

  const pieces  = { ...(game.pieces || {}) };
  const visited = [...(game.visited || [])];

  // Manetsika pio
  delete pieces[origin];
  pieces[target] = myColor;

  // Manala pio nabo (captures)
  if (Array.isArray(capturedSpots)) {
    capturedSpots.forEach(s => delete pieces[s]);
  }

  const newVisited = [...visited, origin];
  const wasCapture = capturedSpots.length > 0;

  // ── AUTO-OK: Tsy jerena ny continuation, mifindra tour foana ──────────────
  // (Ny checkAvailableCaptures dia voasoratra eto fa tsy ampiasaina ankehitriny)
  // Rehefa hampiana ny feature multi-capture → ovana ity andalana ity:
  //   const AUTO_OK_ALWAYS = false;
  //   const canContinue = !AUTO_OK_ALWAYS && wasCapture && checkAvailableCaptures(pieces, target, newVisited, dir, myColor);
  const AUTO_OK_ALWAYS = true; // ← ovana ho false raha hampiana multi-capture
  const canContinue = !AUTO_OK_ALWAYS && wasCapture && checkAvailableCaptures(pieces, target, newVisited, dir, myColor);

  const prevHistory     = Array.isArray(game.moveHistory) ? game.moveHistory : [];
  const newHistoryEntry = { origin, target, capturedSpots: capturedSpots || [] };

  if (canContinue) {
    // ── Multi-capture (disabled ankehitriny) ────────────────────────────────
    await gameRef.update({
      pieces,
      movingPiece: target,
      visited:     newVisited,
      lastDir:     dir || "",
      moveHistory: [...prevHistory, newHistoryEntry],
    });
    return res.status(200).json({ success: true, continuing: true });

  } else {
    // ── AUTO-OK : mifindra tour avy hatrany ─────────────────────────────────
    const nextColor  = myColor === "maintso" ? "mena" : "maintso";
    const fullHistory = [...prevHistory, newHistoryEntry];
    await gameRef.update({
      pieces,
      turn:            nextColor,
      movingPiece:     "",
      visited:         [],
      lastDir:         "",
      moveHistory:     [],
      lastTurnHistory: fullHistory,
      lastTurnColor:   myColor
    });
    return res.status(200).json({ success: true, continuing: false });
  }
}

// ── Mijanona an-tsaina (bouton OK — mbola ampiasaina raha multi-capture) ────
// Body: { uid, gameId, pieces }
async function handleStopMove(body, res) {
  const { uid, gameId, pieces } = body;
  if (!uid || !gameId || !pieces)
    return res.status(400).json({ error: "uid, gameId, pieces required." });

  const gameRef = gamesRef.child(gameId);
  const game    = await rtdbGet(gameRef);
  if (!game) return res.status(404).json({ error: "Game not found." });

  const myColor = game.senderUid === uid ? "maintso" : "mena";
  if (game.turn !== myColor) return res.status(400).json({ error: "Tsy anjaranao." });
  if (!game.movingPiece)     return res.status(400).json({ error: "Tsy misy movingPiece." });

  const nextColor   = myColor === "maintso" ? "mena" : "maintso";
  const stopHistory = Array.isArray(game.moveHistory) ? game.moveHistory : [];
  await gameRef.update({
    pieces,
    turn:            nextColor,
    movingPiece:     "",
    visited:         [],
    lastDir:         "",
    moveHistory:     [],
    lastTurnHistory: stopHistory,
    lastTurnColor:   myColor
  });
  return res.status(200).json({ success: true });
}

// ── Helper: jerena raha misy capture mbola azo atao (multi-capture) ─────────
// (Mbola tsy ampiasaina fa voasoratra ho avy)
const ROWS = ['A','B','C','D','E'];
const COLS = ['1','2','3','4','5','6','7','8','9'];

const ALLOWED_MOVES = {
  'A1':['A2','B1','B2'],'A2':['A1','A3','B2'],'A3':['A2','A4','B2','B3','B4'],
  'A4':['A3','A5','B4'],'A5':['A4','A6','B4','B5','B6'],'A6':['A5','A7','B6'],
  'A7':['A6','A8','B6','B7','B8'],'A8':['A7','A9','B8'],'A9':['A8','B8','B9'],
  'B1':['A1','B2','C1'],'B2':['A1','A2','A3','B1','B3','C1','C2','C3'],'B3':['A3','B2','B4','C3'],
  'B4':['A3','A4','A5','B3','B5','C3','C4','C5'],'B5':['A5','B4','B6','C5'],
  'B6':['A5','A6','A7','B5','B7','C5','C6','C7'],
  'B7':['A7','B6','B8','C7'],'B8':['A7','A8','A9','B7','B9','C7','C8','C9'],'B9':['A9','B8','C9'],
  'C1':['B1','B2','C2','D1','D2'],'C2':['B2','C1','C3','D2'],
  'C3':['B2','B3','B4','C2','C4','D2','D3','D4'],
  'C4':['B4','C3','C5','D4'],'C5':['B4','B5','B6','C4','C6','D4','D5','D6'],'C6':['B6','C5','C7','D6'],
  'C7':['B6','B7','B8','C6','C8','D6','D7','D8'],'C8':['B8','C7','C9','D8'],
  'C9':['B8','B9','C8','D8','D9'],
  'D1':['C1','D2','E1'],'D2':['C1','C2','C3','D1','D3','E1','E2','E3'],'D3':['C3','D2','D4','E3'],
  'D4':['C3','C4','C5','D3','D5','E3','E4','E5'],'D5':['C5','D4','D6','E5'],
  'D6':['C5','C6','C7','D5','D7','E5','E6','E7'],
  'D7':['C7','D6','D8','E7'],'D8':['C7','C8','C9','D7','D9','E7','E8','E9'],'D9':['C9','D8','E9'],
  'E1':['D1','D2','E2'],'E2':['D2','E1','E3'],'E3':['D2','D3','D4','E2','E4'],
  'E4':['D4','E3','E5'],'E5':['D4','D5','D6','E4','E6'],'E6':['D6','E5','E7'],
  'E7':['D6','D7','D8','E6','E8'],'E8':['D8','E7','E9'],'E9':['D8','D9','E8'],
};

function getCaptures(pieces, s, e, color) {
  const r1=ROWS.indexOf(s[0]),c1=COLS.indexOf(s[1]),r2=ROWS.indexOf(e[0]),c2=COLS.indexOf(e[1]);
  const enemy = color==="maintso"?"mena":"maintso", dr=r2-r1, dc=c2-c1;
  const scan=(row,col,sr,sc)=>{
    let res=[],cr=row+sr,cc=col+sc;
    while(cr>=0&&cr<5&&cc>=0&&cc<9&&pieces[ROWS[cr]+COLS[cc]]===enemy){res.push(ROWS[cr]+COLS[cc]);cr+=sr;cc+=sc;}
    return res;
  };
  return { approach: scan(r2,c2,dr,dc), withdrawal: scan(r1,c1,-dr,-dc) };
}

function checkAvailableCaptures(pieces, s, visited, lastDir, color) {
  const moves = ALLOWED_MOVES[s] || [];
  return moves.some(t => {
    if (pieces[t] || (visited && visited.includes(t))) return false;
    const r1=ROWS.indexOf(s[0]),c1=COLS.indexOf(s[1]),r2=ROWS.indexOf(t[0]),c2=COLS.indexOf(t[1]);
    const dir=`${r2-r1},${c2-c1}`;
    if (lastDir && lastDir === dir) return false;
    const caps = getCaptures(pieces, s, t, color);
    return (caps.approach.length > 0 || caps.withdrawal.length > 0);
  });
}
