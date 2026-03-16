// game.js — API ho an'ny lalao Fanorona
// Ny logic rehetra (validation move, capture, turn) dia atao eto server-side
// Ny client (fanorona.html) dia miantso /api/game fotsiny — tsy misy RTDB direct

import admin from "firebase-admin";

if (!process.env.FIREBASE_KEY) throw new Error("FIREBASE_KEY not set");
const allowedOrigin = process.env.ALLOWED_ORIGIN;

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
  }
  admin.initializeApp({
    credential:  admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
}

const rtdb     = admin.database();
const gamesRef = rtdb.ref("games");

// ── Constantes plateau ────────────────────────────────────────────────────
const ROWS = ['A','B','C','D','E'];
const COLS = ['1','2','3','4','5','6','7','8','9'];

const ALLOWED_MOVES = {
  'A1':['A2','B1','B2'],'A2':['A1','A3','B2'],'A3':['A2','A4','B2','B3','B4'],
  'A4':['A3','A5','B4'],'A5':['A4','A6','B4','B5','B6'],'A6':['A5','A7','B6'],
  'A7':['A6','A8','B6','B7','B8'],'A8':['A7','A9','B8'],'A9':['A8','B8','B9'],
  'B1':['A1','B2','C1'],'B2':['A1','A2','A3','B1','B3','C1','C2','C3'],'B3':['A3','B2','B4','C3'],
  'B4':['A3','A4','A5','B3','B5','C3','C4','C5'],'B5':['A5','B4','B6','C5'],'B6':['A5','A6','A7','B5','B7','C5','C6','C7'],
  'B7':['A7','B6','B8','C7'],'B8':['A7','A8','A9','B7','B9','C7','C8','C9'],'B9':['A9','B8','C9'],
  'C1':['B1','B2','C2','D1','D2'],'C2':['B2','C1','C3','D2'],'C3':['B2','B3','B4','C2','C4','D2','D3','D4'],
  'C4':['B4','C3','C5','D4'],'C5':['B4','B5','B6','C4','C6','D4','D5','D6'],'C6':['B6','C5','C7','D6'],
  'C7':['B6','B7','B8','C6','C8','D6','D7','D8'],'C8':['B8','C7','C9','D8'],'C9':['B8','B9','C8','D8','D9'],
  'D1':['C1','D2','E1'],'D2':['C1','C2','C3','D1','D3','E1','E2','E3'],'D3':['C3','D2','D4','E3'],
  'D4':['C3','C4','C5','D3','D5','E3','E4','E5'],'D5':['C5','D4','D6','E5'],'D6':['C5','C6','C7','D5','D7','E5','E6','E7'],
  'D7':['C7','D6','D8','E7'],'D8':['C7','C8','C9','D7','D9','E7','E8','E9'],'D9':['C9','D8','E9'],
  'E1':['D1','D2','E2'],'E2':['D2','E1','E3'],'E3':['D2','D3','D4','E2','E4'],
  'E4':['D4','E3','E5'],'E5':['D4','D5','D6','E4','E6'],'E6':['D6','E5','E7'],
  'E7':['D6','D7','D8','E6','E8'],'E8':['D8','E7','E9'],'E9':['D8','D9','E8'],
};

// ── Handler principal ─────────────────────────────────────────────────────
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
      case "get-state":       return await handleGetState(payload, res);
      case "move":            return await handleMove(payload, res);
      case "choose-capture":  return await handleChooseCapture(payload, res);
      case "stop-move":       return await handleStopMove(payload, res);
      default: return res.status(400).json({ error: "Invalid action." });
    }
  } catch (err) {
    console.error(`GAME ERROR [${action}]:`, err);
    return res.status(500).json({ error: "An unexpected server error occurred." });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

async function getGame(gameId) {
  const snap = await gamesRef.child(gameId).once("value");
  return snap.exists() ? snap.val() : null;
}

// ── FIX: getCaptures corrigé ──────────────────────────────────────────────
// approach  : depuis la case d'arrivée (e), on continue dans la même direction (dr,dc)
// withdrawal: depuis la case de départ  (s), on recule dans la direction opposée (-dr,-dc)
// Le scan ne comprend PAS le point de départ — il commence à (point + vecteur).
function getCaptures(pieces, s, e, color) {
  const r1 = ROWS.indexOf(s[0]), c1 = COLS.indexOf(s[1]);
  const r2 = ROWS.indexOf(e[0]), c2 = COLS.indexOf(e[1]);
  const enemy = color === "mena" ? "maintso" : "mena";
  const dr = r2 - r1, dc = c2 - c1;

  const scan = (startR, startC, sr, sc) => {
    const result = [];
    let cr = startR + sr, cc = startC + sc;
    while (cr >= 0 && cr < 5 && cc >= 0 && cc < 9) {
      const key = ROWS[cr] + COLS[cc];
      if (pieces[key] !== enemy) break;
      result.push(key);
      cr += sr; cc += sc;
    }
    return result;
  };

  return {
    approach:   scan(r2, c2,  dr,  dc),   // continue depuis l'arrivée
    withdrawal: scan(r1, c1, -dr, -dc),   // recule depuis le départ
  };
}

function playerHasAnyCapture(pieces, color) {
  for (const s in pieces) {
    if (pieces[s] !== color) continue;
    for (const t of (ALLOWED_MOVES[s] || [])) {
      if (!pieces[t]) {
        const c = getCaptures(pieces, s, t, color);
        if (c.approach.length > 0 || c.withdrawal.length > 0) return true;
      }
    }
  }
  return false;
}

function checkAvailableCaptures(pieces, s, visited, lastDir, color) {
  return (ALLOWED_MOVES[s] || []).some(t => {
    if (pieces[t] || (visited && visited.includes(t))) return false;
    const r1 = ROWS.indexOf(s[0]), c1 = COLS.indexOf(s[1]);
    const r2 = ROWS.indexOf(t[0]), c2 = COLS.indexOf(t[1]);
    const dir = `${r2-r1},${c2-c1}`;
    if (dir === lastDir) return false;
    const caps = getCaptures(pieces, s, t, color);
    return caps.approach.length > 0 || caps.withdrawal.length > 0;
  });
}

// ── get-state ─────────────────────────────────────────────────────────────
async function handleGetState(body, res) {
  const { uid, gameId } = body;
  if (!uid || !gameId) return res.status(400).json({ error: "UID and gameId required." });

  const game = await getGame(gameId);
  if (!game) return res.status(404).json({ error: "Game not found." });

  // Vérifier que uid est bien un des joueurs
  let myColor = null;
  if (game.senderUid && game.receiverUid) {
    if (game.senderUid !== uid && game.receiverUid !== uid)
      return res.status(403).json({ error: "Not authorized." });
    myColor = game.senderUid === uid ? "maintso" : "mena";
  } else {
    // Fallback: vérifier via gameInvites si les champs manquent
    const inviteSnap = await rtdb.ref(`gameInvites/${gameId}`).once("value");
    if (inviteSnap.exists()) {
      const invite = inviteSnap.val();
      if (invite.fromUid !== uid && invite.toUid !== uid)
        return res.status(403).json({ error: "Not authorized." });
      myColor = invite.fromUid === uid ? "maintso" : "mena";
      // Corriger RTDB — ajouter les champs manquants
      await gamesRef.child(gameId).update({
        senderUid:   invite.fromUid,
        receiverUid: invite.toUid
      });
    } else {
      return res.status(403).json({ error: "Not authorized." });
    }
  }

  return res.status(200).json({
    success:         true,
    pieces:          game.pieces       || {},
    turn:            game.turn         || "maintso",
    movingPiece:     game.movingPiece  || "",
    visited:         game.visited      || [],
    lastDir:         game.lastDir      || "",
    myColor,
    pendingCaptures: game.pendingCaptures || null
  });
}

// ── move ──────────────────────────────────────────────────────────────────
async function handleMove(body, res) {
  const { uid, gameId, from, to } = body;
  if (!uid || !gameId || !from || !to)
    return res.status(400).json({ error: "uid, gameId, from, to required." });

  const game = await getGame(gameId);
  if (!game) return res.status(404).json({ error: "Game not found." });

  // FIX: authorization check AVANT de déduire myColor
  if (game.senderUid !== uid && game.receiverUid !== uid)
    return res.status(403).json({ error: "Not authorized." });

  const myColor = game.senderUid === uid ? "maintso" : "mena";

  if (game.turn !== myColor)
    return res.status(400).json({ error: "Not your turn." });
  if (game.pendingCaptures)
    return res.status(400).json({ error: "Choose capture type first." });

  const pieces  = game.pieces;
  const visited = game.visited || [];
  const lastDir = game.lastDir || "";

  if (pieces[from] !== myColor)
    return res.status(400).json({ error: "Not your piece." });
  if (!( ALLOWED_MOVES[from] || [] ).includes(to))
    return res.status(400).json({ error: "Invalid move: not adjacent." });
  if (pieces[to])
    return res.status(400).json({ error: "Target spot is occupied." });
  if (visited.includes(to))
    return res.status(400).json({ error: "Already visited this spot." });

  const r1 = ROWS.indexOf(from[0]), c1 = COLS.indexOf(from[1]);
  const r2 = ROWS.indexOf(to[0]),   c2 = COLS.indexOf(to[1]);
  const dir = `${r2-r1},${c2-c1}`;
  if (game.movingPiece && lastDir === dir)
    return res.status(400).json({ error: "Cannot move in the same direction." });

  const globalCapture = playerHasAnyCapture(pieces, myColor);
  const caps = getCaptures(pieces, from, to, myColor);
  const isCaptureMove = caps.approach.length > 0 || caps.withdrawal.length > 0;
  if (globalCapture && !isCaptureMove)
    return res.status(400).json({ error: "Must capture if possible." });

  const newPieces = { ...pieces };
  delete newPieces[from];
  newPieces[to] = myColor;
  const newVisited = [...visited, from];

  if (isCaptureMove) {
    if (caps.approach.length > 0 && caps.withdrawal.length > 0) {
      await gamesRef.child(gameId).update({
        pieces:      newPieces,
        movingPiece: to,
        visited:     newVisited,
        lastDir:     dir,
        pendingCaptures: {
          approach:   caps.approach,
          withdrawal: caps.withdrawal,
          target:     to,
          newVisited,
          dir
        }
      });
      return res.status(200).json({
        success:           true,
        needChooseCapture: true,
        approach:          caps.approach,
        withdrawal:        caps.withdrawal
      });
    } else {
      const toRemove = [...caps.approach, ...caps.withdrawal];
      toRemove.forEach(t => delete newPieces[t]);
      return await applyFinalizeMove(res, gameId, newPieces, to, newVisited, dir, true, myColor, game);
    }
  } else {
    return await applyFinalizeMove(res, gameId, newPieces, to, newVisited, dir, false, myColor, game);
  }
}

// ── choose-capture ────────────────────────────────────────────────────────
async function handleChooseCapture(body, res) {
  const { uid, gameId, type } = body;
  if (!uid || !gameId || !type)
    return res.status(400).json({ error: "uid, gameId, type required." });
  if (type !== "approach" && type !== "withdrawal")
    return res.status(400).json({ error: "type must be 'approach' or 'withdrawal'." });

  const game = await getGame(gameId);
  if (!game) return res.status(404).json({ error: "Game not found." });

  // FIX: authorization check AVANT de déduire myColor
  if (game.senderUid !== uid && game.receiverUid !== uid)
    return res.status(403).json({ error: "Not authorized." });

  const myColor = game.senderUid === uid ? "maintso" : "mena";

  if (game.turn !== myColor)
    return res.status(400).json({ error: "Not your turn." });
  if (!game.pendingCaptures)
    return res.status(400).json({ error: "No pending capture to resolve." });

  const pc       = game.pendingCaptures;
  const pieces   = { ...game.pieces };
  const toRemove = type === "approach" ? pc.approach : pc.withdrawal;
  toRemove.forEach(t => delete pieces[t]);

  await gamesRef.child(gameId).update({ pendingCaptures: null });

  return await applyFinalizeMove(
    res, gameId, pieces, pc.target, pc.newVisited, pc.dir, true, myColor, game
  );
}

// ── stop-move ─────────────────────────────────────────────────────────────
async function handleStopMove(body, res) {
  const { uid, gameId } = body;
  if (!uid || !gameId) return res.status(400).json({ error: "uid and gameId required." });

  const game = await getGame(gameId);
  if (!game) return res.status(404).json({ error: "Game not found." });

  // FIX: authorization check AVANT de déduire myColor
  if (game.senderUid !== uid && game.receiverUid !== uid)
    return res.status(403).json({ error: "Not authorized." });

  const myColor = game.senderUid === uid ? "maintso" : "mena";

  if (game.turn !== myColor)
    return res.status(400).json({ error: "Not your turn." });
  if (!game.movingPiece)
    return res.status(400).json({ error: "No active move to stop." });

  const nextTurn = myColor === "mena" ? "maintso" : "mena";
  await gamesRef.child(gameId).update({
    turn:            nextTurn,
    movingPiece:     "",
    visited:         [],
    lastDir:         "",
    pendingCaptures: null
  });

  return res.status(200).json({ success: true });
}

// ── applyFinalizeMove ─────────────────────────────────────────────────────
async function applyFinalizeMove(res, gameId, pieces, cur, visited, dir, wasCapture, myColor, game) {
  if (wasCapture && checkAvailableCaptures(pieces, cur, visited, dir, myColor)) {
    await gamesRef.child(gameId).update({
      pieces,
      movingPiece:     cur,
      visited,
      lastDir:         dir,
      pendingCaptures: null
    });
    return res.status(200).json({ success: true, continueTurn: true });
  } else {
    const nextTurn = myColor === "mena" ? "maintso" : "mena";
    await gamesRef.child(gameId).update({
      pieces,
      turn:            nextTurn,
      movingPiece:     "",
      visited:         [],
      lastDir:         "",
      pendingCaptures: null
    });
    return res.status(200).json({ success: true, continueTurn: false });
  }
}
