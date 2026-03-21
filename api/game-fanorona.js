// api/game.js
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

const rtdb        = admin.database();
const gamesRef    = rtdb.ref("games");
const invitesRef  = rtdb.ref("gameInvites");

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
      case "get-state":          return await handleGetState(payload, res);
      case "make-move":          return await handleMakeMove(payload, res);
      case "stop-move":          return await handleStopMove(payload, res);
      case "get-firebase-token": return await handleGetFirebaseToken(payload, res);
      case "update-timers":      return await handleUpdateTimers(payload, res);
      case "declare-winner":     return await handleDeclareWinner(payload, res);
      default: return res.status(400).json({ error: "Invalid action." });
    }
  } catch (err) {
    console.error(`GAME API ERROR [${action}]:`, err);
    return res.status(500).json({ error: "An unexpected server error occurred." });
  }
}

function getMyColor(game, uid) {
  if (game.senderUid === uid) {
    return game.senderColor   || "maintso";
  } else {
    return game.receiverColor || "mena";
  }
}

async function handleGetState(body, res) {
  const { uid, gameId } = body;
  if (!uid || !gameId) return res.status(400).json({ error: "uid and gameId required." });

  const game = await rtdbGet(gamesRef.child(gameId));
  if (!game) return res.status(404).json({ error: "Game not found." });
  if (game.senderUid !== uid && game.receiverUid !== uid)
    return res.status(403).json({ error: "Not authorized." });

  return res.status(200).json({ success: true, game });
}

async function handleMakeMove(body, res) {
  const { uid, gameId, origin, target, capturedSpots = [], dir } = body;
  if (!uid || !gameId || !origin || !target)
    return res.status(400).json({ error: "uid, gameId, origin, target required." });

  const gameRef = gamesRef.child(gameId);
  const game    = await rtdbGet(gameRef);
  if (!game)                         return res.status(404).json({ error: "Game not found." });
  if (game.senderUid !== uid && game.receiverUid !== uid)
                                     return res.status(403).json({ error: "Not authorized." });

  const myColor = getMyColor(game, uid);
  if (game.turn !== myColor)         return res.status(400).json({ error: "Tsy anjaranao." });

  if (game.movingPiece && game.movingPiece !== origin)
    return res.status(400).json({ error: "Pio hafa tsy azo hetsehina izao." });

  const pieces  = { ...(game.pieces || {}) };
  const visited = [...(game.visited || [])];

  delete pieces[origin];
  pieces[target] = myColor;

  if (Array.isArray(capturedSpots)) {
    capturedSpots.forEach(s => delete pieces[s]);
  }

  const newVisited = [...visited, origin];
  const wasCapture = capturedSpots.length > 0;

  const canContinue = wasCapture && checkAvailableCaptures(pieces, target, newVisited, dir, myColor);

  const prevHistory     = Array.isArray(game.moveHistory) ? game.moveHistory : [];
  const newHistoryEntry = { origin, target, capturedSpots: capturedSpots || [] };
  const nowMs           = Date.now();

  function timerUpdateForTurn(nextTurn) {
    const upd = { timerRunning: nextTurn, timerLastTick: nowMs };
    if (game.timerRunning && game.timerLastTick) {
      const elapsed = Math.max(0, nowMs - game.timerLastTick);
      if (game.timerRunning === "maintso") {
        upd.timerMaintso = Math.max(0, (game.timerMaintso || 0) - elapsed);
      } else {
        upd.timerMena = Math.max(0, (game.timerMena || 0) - elapsed);
      }
    }
    return upd;
  }

  if (canContinue) {
    await gameRef.update({
      pieces,
      movingPiece: target,
      visited:     newVisited,
      lastDir:     dir || "",
      moveHistory: [...prevHistory, newHistoryEntry],
    });
    return res.status(200).json({ success: true, continuing: true });
  } else {
    const nextColor   = myColor === "maintso" ? "mena" : "maintso";
    const fullHistory = [...prevHistory, newHistoryEntry];
    const timerUpd    = timerUpdateForTurn(nextColor);
    const winner = checkGameOver(
      pieces,
      timerUpd.timerMaintso !== undefined ? timerUpd.timerMaintso : (game.timerMaintso || 0),
      timerUpd.timerMena    !== undefined ? timerUpd.timerMena    : (game.timerMena    || 0),
      game.minutes
    );
    const updatePayload = {
      pieces,
      turn:            nextColor,
      movingPiece:     "",
      visited:         [],
      lastDir:         "",
      moveHistory:     [],
      lastTurnHistory: fullHistory,
      lastTurnColor:   myColor,
      ...timerUpd,
    };
    if (winner) updatePayload.winner = winner;
    await gameRef.update(updatePayload);
    return res.status(200).json({ success: true, continuing: false, winner: winner || null });
  }
}

// Body: { uid, gameId, pieces }
async function handleStopMove(body, res) {
  const { uid, gameId, pieces } = body;
  if (!uid || !gameId || !pieces)
    return res.status(400).json({ error: "uid, gameId, pieces required." });

  const gameRef = gamesRef.child(gameId);
  const game    = await rtdbGet(gameRef);
  if (!game) return res.status(404).json({ error: "Game not found." });

  const myColor = getMyColor(game, uid);
  if (game.turn !== myColor) return res.status(400).json({ error: "Tsy anjaranao." });
  if (!game.movingPiece)     return res.status(400).json({ error: "Tsy misy movingPiece." });

  const nextColor   = myColor === "maintso" ? "mena" : "maintso";
  const stopHistory = Array.isArray(game.moveHistory) ? game.moveHistory : [];
  const stopNow     = Date.now();
  const stopTimerUpd = { timerRunning: nextColor, timerLastTick: stopNow };
  if (game.timerRunning && game.timerLastTick) {
    const elapsed = Math.max(0, stopNow - game.timerLastTick);
    if (game.timerRunning === "maintso") {
      stopTimerUpd.timerMaintso = Math.max(0, (game.timerMaintso || 0) - elapsed);
    } else {
      stopTimerUpd.timerMena = Math.max(0, (game.timerMena || 0) - elapsed);
    }
  }
  const stopWinner = checkGameOver(
    pieces,
    stopTimerUpd.timerMaintso !== undefined ? stopTimerUpd.timerMaintso : (game.timerMaintso || 0),
    stopTimerUpd.timerMena    !== undefined ? stopTimerUpd.timerMena    : (game.timerMena    || 0),
    game.minutes
  );
  const stopPayload = {
    pieces,
    turn:            nextColor,
    movingPiece:     "",
    visited:         [],
    lastDir:         "",
    moveHistory:     [],
    lastTurnHistory: stopHistory,
    lastTurnColor:   myColor,
    ...stopTimerUpd,
  };
  if (stopWinner) stopPayload.winner = stopWinner;
  await gameRef.update(stopPayload);
  return res.status(200).json({ success: true, winner: stopWinner || null });
}

// ── Declare winner : appelé par le client quand le timer expire côté client
// Écrit game.winner dans RTDB → les deux joueurs reçoivent le push Firebase
async function handleDeclareWinner(body, res) {
  const { uid, gameId, winner } = body;
  if (!uid || !gameId || !winner) return res.status(400).json({ error: "uid, gameId, winner required." });
  if (winner !== "maintso" && winner !== "mena") return res.status(400).json({ error: "Invalid winner." });

  const gameRef = gamesRef.child(gameId);
  const game    = await rtdbGet(gameRef);
  if (!game) return res.status(404).json({ error: "Game not found." });
  if (game.senderUid !== uid && game.receiverUid !== uid)
    return res.status(403).json({ error: "Not authorized." });

  // Idempotent : si winner déjà écrit, ne pas écraser
  if (game.winner) return res.status(200).json({ success: true, winner: game.winner });

  // Vérifier que le timer du perdant est bien à 0 (sécurité, tolérance 2s pour la latence)
  if (game.minutes) {
    const loser      = winner === "maintso" ? "mena" : "maintso";
    const loserMs    = loser === "maintso" ? (game.timerMaintso || 0) : (game.timerMena || 0);
    const lastTick   = game.timerLastTick || 0;
    const elapsed    = Math.max(0, Date.now() - lastTick);
    const actualLeft = Math.max(0, loserMs - elapsed);
    if (actualLeft > 2000) return res.status(400).json({ error: "Timer not expired yet." });
  }

  await gameRef.update({ winner });
  return res.status(200).json({ success: true, winner });
}

// ── Timer update : met à jour les timers dans RTDB après chaque changement de tour ──
async function handleUpdateTimers(body, res) {
  const { uid, gameId } = body;
  if (!uid || !gameId) return res.status(400).json({ error: "uid and gameId required." });

  const gameRef = gamesRef.child(gameId);
  const game    = await rtdbGet(gameRef);
  if (!game) return res.status(404).json({ error: "Game not found." });
  if (game.senderUid !== uid && game.receiverUid !== uid)
    return res.status(403).json({ error: "Not authorized." });

  const running  = game.timerRunning;
  const lastTick = game.timerLastTick;
  const now      = Date.now();

  // ── Logique :
  //   - "running" = couleur du joueur dont le chrono TOURNAIT avant cet appel
  //   - "game.turn" = couleur du joueur qui VA jouer maintenant
  //   - On déduit le temps écoulé de "running", puis on passe le chrono à "game.turn"
  //
  // Cas spécial : premier appel (running=null ou lastTick=null)
  //   → le joueur qui vient de jouer est l'OPPOSÉ de game.turn
  //   → on démarre le chrono pour game.turn (le joueur qui va jouer)
  // ──
  // ── Invariant :
  //   timerRunning = game.turn = mpilalao ANKEHITRINY manana anjara (chrono miisa)
  //   Rehefa miova tour (update-timers alefa) :
  //     1. Deduit elapsed avy amin'ny mpilalao efa nanao (= "running" = ancien game.turn)
  //     2. Mametraka timerRunning = game.turn (vaovao = mpilalao manaraka)
  // ──
  if (!running || !lastTick) {
    // Lalao vao manomboka : mametraka timerRunning = game.turn (maintso manomboka)
    await gameRef.update({ timerRunning: game.turn, timerLastTick: now });
    return res.status(200).json({ success: true });
  }

  // running = mpilalao efa nanao (ilay miisa) → deduit elapsed avy aminy
  // game.turn = mpilalao vaovao → ny chrono dia ampindramina azy
  const elapsed = Math.max(0, now - lastTick);
  const update  = { timerLastTick: now, timerRunning: game.turn };

  if (running === "maintso") {
    update.timerMaintso = Math.max(0, (game.timerMaintso || 0) - elapsed);
  } else {
    update.timerMena = Math.max(0, (game.timerMena || 0) - elapsed);
  }

  await gameRef.update(update);
  return res.status(200).json({ success: true });
}

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

// ── Vérifie fin de partie et retourne le winner ou null ──
// winner = couleur gagnante ("maintso" ou "mena"), null si pas encore terminé
function checkGameOver(pieces, timerMaintso, timerMena, minutes) {
  const maintsoCount = Object.values(pieces).filter(v => v === "maintso").length;
  const menaCount    = Object.values(pieces).filter(v => v === "mena").length;

  // Plus de pièces
  if (maintsoCount === 0) return "mena";
  if (menaCount    === 0) return "maintso";

  // Timer épuisé (seulement si le jeu a des timers configurés)
  if (minutes) {
    if ((timerMaintso || 0) <= 0) return "mena";
    if ((timerMena    || 0) <= 0) return "maintso";
  }

  return null;
}

// ── Génère un custom token Firebase pour le client (WebSocket auth) ──
async function handleGetFirebaseToken(body, res) {
  const { uid, gameId } = body;
  if (!uid || !gameId)
    return res.status(400).json({ error: "uid and gameId required." });

  const game = await rtdbGet(gamesRef.child(gameId));
  if (!game)
    return res.status(404).json({ error: "Game not found." });
  if (game.senderUid !== uid && game.receiverUid !== uid)
    return res.status(403).json({ error: "Not authorized." });

  const token = await admin.auth().createCustomToken(uid);
  return res.status(200).json({ success: true, token });
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
