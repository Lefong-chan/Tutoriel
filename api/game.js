const admin = require('firebase-admin');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        }),
        databaseURL: process.env.FIREBASE_DATABASE_URL
    });
}

const db = admin.database();

export default async function handler(req, res) {
    const { action, gameID, uid, moveData } = req.body;
    const gameRef = db.ref(`games/${gameID}`);

    switch (action) {
        case 'get-status':
            const snap = await gameRef.once('value');
            return res.status(200).json({ success: true, game: snap.val() });

        case 'update-move':
            await gameRef.update(moveData);
            return res.status(200).json({ success: true });

        case 'stop-move':
            const g = (await gameRef.once('value')).val();
            const nextTurn = g.turn === 'mena' ? 'maintso' : 'mena';
            await gameRef.update({ turn: nextTurn, movingPiece: "", visited: [], lastDir: "" });
            return res.status(200).json({ success: true });

        default:
            return res.status(400).json({ error: "Action tsy fantatra" });
    }
}
