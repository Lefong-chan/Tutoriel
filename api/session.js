// api/game.js
// Fitantanana ny état ny lalao Fanorona ao amin'ny Firebase RTDB
// Tsy misy Firebase config eto – ampiasaina ny admin SDK avy amin'ny env vars (tahaka session.js)

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
      case "get-state":         return await handleGetState(payload, res);
      case "make-move":         return await handleMakeMove(payload, res);
      case "stop-move":         return await handleStopMove(payload, res);
      case "restart-game":      return await handleRestartGame(payload, res);
      case "request-restart":   return await handleRequestRestart(payload, res);
      case "get-restart-request": return await handleGetRestartRequest(payload, res);
      case "confirm-restart":   return await handleConfirmRestart(payload, res);
      case "cancel-restart":    return await handleCancelRestart(payload, res);
      default: return res.status(400).json({ error: "Invalid action." });
    }
  } catch (err) {
    console.error(`GAME API ERROR [${action}]:`, err);
    return res.status(500).json({ error: "An unexpected server error occurred." });
  }
}

// ── Helper: mahazo ny color marina arakaraka senderColor/receiverColor ──────
// Fallback: sender=maintso, receiver=mena (raha game taloha tsy misy senderColor)
function getMyColor(game, uid) {
  if (game.senderUid === uid) {
    return game.senderColor   || "maintso";
  } else {
    return game.receiverColor || "mena";
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

// ── Manao dingana (miampy capture) ─────────────────────────────────────────
// Body: { uid, gameId, origin, target, capturedSpots, captureType }
//   origin        : toerana nialan'ny pio (ex: "C5")
//   target        : toerana nialanana (ex: "C6")
//   capturedSpots : ["D6","E6"] – pio nabo nanalana
//   captureType   : "approach" | "withdrawal" | null
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

  // Raha misy movingPiece, ny origin dia tsy maintsy izany movingPiece izany
  if (game.movingPiece && game.movingPiece !== origin)
    return res.status(400).json({ error: "Pio hafa tsy azo hetsehina izao." });

  const pieces  = { ...(game.pieces || {}) };
  const visited = [...(game.visited || [])];

  // Manetsika pio
  delete pieces[origin];
  pieces[target] = myColor;

  // Manala pio nabo
  if (Array.isArray(capturedSpots)) {
    capturedSpots.forEach(s => delete pieces[s]);
  }

  const newVisited = [...visited, origin];
  const wasCapture = capturedSpots.length > 0;

  // Jerena raha mbola azo hihazoana mihetsika (multi-capture)
  const canContinue = wasCapture && checkAvailableCaptures(pieces, target, newVisited, dir, myColor);

  const prevHistory    = Array.isArray(game.moveHistory)   ? game.moveHistory   : [];
  const newHistoryEntry = { origin, target, capturedSpots: capturedSpots || [] };
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
    const nextColor = myColor === "maintso" ? "mena" : "maintso";
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

// ── Mijanona an-tsaina (bouton OK) ─────────────────────────────────────────
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

  const nextColor = myColor === "maintso" ? "mena" : "maintso";
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

// ── Request restart (iray mangataka, iray manaiky na mandà) ───────────────
// Body: { uid, gameId }
async function handleRequestRestart(body, res) {
  const { uid, gameId } = body;
  if (!uid || !gameId) return res.status(400).json({ error: "uid and gameId required." });
  const gameRef = gamesRef.child(gameId);
  const game    = await rtdbGet(gameRef);
  if (!game) return res.status(404).json({ error: "Game not found." });
  if (game.senderUid !== uid && game.receiverUid !== uid)
    return res.status(403).json({ error: "Not authorized." });

  // Voatahiry ny uid nangataka sy ny username
  const myColor = getMyColor(game, uid);
  const myUsername = game.senderUid === uid ? game.senderUsername : game.receiverUsername;
  await gameRef.update({
    restartRequest:         uid,
    restartRequestUsername: myUsername,
    restartConfirmed:       false,
  });
  return res.status(200).json({ success: true });
}

// ── Jerena ny restart request ──────────────────────────────────────────────
// Body: { uid, gameId }
async function handleGetRestartRequest(body, res) {
  const { uid, gameId } = body;
  if (!uid || !gameId) return res.status(400).json({ error: "uid and gameId required." });
  const game = await rtdbGet(gamesRef.child(gameId));
  if (!game) return res.status(404).json({ error: "Game not found." });
  if (game.senderUid !== uid && game.receiverUid !== uid)
    return res.status(403).json({ error: "Not authorized." });

  const requested  = !!(game.restartRequest);
  const requestedBy = game.restartRequest || null;
  const confirmed  = !!(game.restartConfirmed);

  if (confirmed) {
    // Mamerina ny myColor — TSY MIOVA (color an'ilay mpilalao tsy ovaina)
    const myColor = getMyColor(game, uid);
    return res.status(200).json({
      success:       true,
      requested:     false,
      confirmed:     true,
      myColor,
      senderColor:   game.senderColor   || "maintso",
      receiverColor: game.receiverColor || "mena",
    });
  }

  return res.status(200).json({
    success: true,
    requested,
    requestedBy,
    requestedByUsername: game.restartRequestUsername || null,
    confirmed: false,
  });
}

// ── Manaiky restart ────────────────────────────────────────────────────────
// Body: { uid, gameId }
async function handleConfirmRestart(body, res) {
  const { uid, gameId } = body;
  if (!uid || !gameId) return res.status(400).json({ error: "uid and gameId required." });
  const gameRef = gamesRef.child(gameId);
  const game    = await rtdbGet(gameRef);
  if (!game) return res.status(404).json({ error: "Game not found." });
  if (game.senderUid !== uid && game.receiverUid !== uid)
    return res.status(403).json({ error: "Not authorized." });
  if (game.restartRequest === uid)
    return res.status(400).json({ error: "Tsy azonao ekena ny fangatahana nataonao." });

  // TSY OVAINA ny senderColor/receiverColor — mitovy amin'ny teo aloha
  const senderColor   = game.senderColor   || "maintso";
  const receiverColor = game.receiverColor || "mena";

  // Ny turn voalohany no mifamadika:
  // Raha maintso nanomboka teo aloha → mena izao, ary ny mifanohitra
  const prevFirstTurn = game.prevFirstTurn || "maintso";
  const newFirstTurn  = prevFirstTurn === "maintso" ? "mena" : "maintso";

  // initialPieces: mena foana rows A,B (ambony); maintso rows D,E (ambany)
  // Tsy ovaina arakaraka ny color — pieces mitovy foana
  const initialPieces = {};
  const R = ["A","B","C","D","E"];
  const C = ["1","2","3","4","5","6","7","8","9"];
  R.forEach((r, ri) => {
    C.forEach((c, ci) => {
      const key = r + c;
      if (ri < 2)       initialPieces[key] = "mena";
      else if (ri > 2)  initialPieces[key] = "maintso";
      else {
        if ([1,3,6,8].includes(ci))      initialPieces[key] = "mena";
        else if ([0,2,5,7].includes(ci)) initialPieces[key] = "maintso";
      }
    });
  });

  await gameRef.set({
    pieces:                initialPieces,
    turn:                  newFirstTurn,   // mifamadika: maintso↔mena
    prevFirstTurn:         newFirstTurn,   // voatahiry ho an'ny restart manaraka
    senderUid:             game.senderUid,
    senderUsername:        game.senderUsername,
    senderColor:           senderColor,    // TSY MIOVA
    receiverUid:           game.receiverUid,
    receiverUsername:      game.receiverUsername,
    receiverColor:         receiverColor,  // TSY MIOVA
    startedAt:             Date.now(),
    movingPiece:           "",
    visited:               [],
    lastDir:               "",
    moveHistory:           [],
    lastTurnHistory:       [],
    lastTurnColor:         "",
    restartRequest:        null,
    restartRequestUsername: null,
    restartConfirmed:      true,
  });

  // myColor = color an'ilay mpilalao — TSY MIOVA
  const myColor = game.senderUid === uid ? senderColor : receiverColor;
  return res.status(200).json({
    success:       true,
    confirmed:     true,
    myColor,
    senderColor,
    receiverColor,
  });
}

// ── Mandà restart ──────────────────────────────────────────────────────────
// Body: { uid, gameId }
async function handleCancelRestart(body, res) {
  const { uid, gameId } = body;
  if (!uid || !gameId) return res.status(400).json({ error: "uid and gameId required." });
  const gameRef = gamesRef.child(gameId);
  const game    = await rtdbGet(gameRef);
  if (!game) return res.status(404).json({ error: "Game not found." });

  await gameRef.update({
    restartRequest:         null,
    restartRequestUsername: null,
    restartConfirmed:       false,
  });
  return res.status(200).json({ success: true });
}

// ── Restart game ───────────────────────────────────────────────────────────
// Body: { uid, gameId }
// Mamerina ny lalao: mifamadika ny turn voalohany sy ny senderColor/receiverColor
// Ilay tsy nanomboka voalohany no hanomboka amin'ny lalao vaovao
async function handleRestartGame(body, res) {
  const { uid, gameId } = body;
  if (!uid || !gameId) return res.status(400).json({ error: "uid and gameId required." });

  const gameRef = gamesRef.child(gameId);
  const game    = await rtdbGet(gameRef);
  if (!game) return res.status(404).json({ error: "Game not found." });
  if (game.senderUid !== uid && game.receiverUid !== uid)
    return res.status(403).json({ error: "Not authorized." });

  // Mifamadika ny senderColor sy receiverColor
  const prevSenderColor   = game.senderColor   || "maintso";
  const prevReceiverColor = game.receiverColor || "mena";
  const newSenderColor    = prevSenderColor   === "maintso" ? "mena"    : "maintso";
  const newReceiverColor  = prevReceiverColor === "maintso" ? "mena"    : "maintso";

  // Ny turn voalohany = maintso foana (araka ny fitsipika)
  // Nefa ny mpilalao izay nanana maintso dia mifamadika koa
  // → ilay tsy maintso teo dia maintso izao → izy no manomboka
  const initialPieces = {};
  const R = ["A","B","C","D","E"];
  const C = ["1","2","3","4","5","6","7","8","9"];
  R.forEach((r, ri) => {
    C.forEach((c, ci) => {
      const key = r + c;
      if (ri < 2)       initialPieces[key] = "mena";
      else if (ri > 2)  initialPieces[key] = "maintso";
      else {
        if ([1,3,6,8].includes(ci))      initialPieces[key] = "mena";
        else if ([0,2,5,7].includes(ci)) initialPieces[key] = "maintso";
      }
    });
  });

  await gameRef.set({
    pieces:          initialPieces,
    turn:            "maintso",
    senderUid:       game.senderUid,
    senderUsername:  game.senderUsername,
    senderColor:     newSenderColor,
    receiverUid:     game.receiverUid,
    receiverUsername: game.receiverUsername,
    receiverColor:   newReceiverColor,
    startedAt:       Date.now(),
    movingPiece:     "",
    visited:         [],
    lastDir:         "",
    moveHistory:     [],
    lastTurnHistory: [],
    lastTurnColor:   "",
  });

  return res.status(200).json({
    success:       true,
    senderColor:   newSenderColor,
    receiverColor: newReceiverColor,
    myColor:       game.senderUid === uid ? newSenderColor : newReceiverColor,
  });
}

// ── Helper: jerena raha misy capture mbola azo atao ────────────────────────
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
