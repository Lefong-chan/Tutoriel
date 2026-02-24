import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY)),
    databaseURL: "https://tutoriel-ff487-default-rtdb.firebaseio.com/"
  });
}

const db = admin.database();

function generateUID() {
  return Math.floor(100000000 + Math.random() * 900000000).toString();
}

export default async function handler(req, res) {

  const { username, email } = req.body;

  let uid;
  let exists = true;

  while (exists) {
    uid = generateUID();
    const check = await db.ref("users/" + uid).get();
    if (!check.exists()) exists = false;
  }

  await db.ref("users/" + uid).set({
    uid,
    username,
    email,
    provider: "google",
    createdAt: Date.now()
  });

  res.json({ success: true });
    }
