import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY)),
    databaseURL: "https://tutoriel-ff487-default-rtdb.firebaseio.com/"
  });
}

const db = admin.database();

export default async function handler(req, res) {

  const { email } = req.body;

  const snap = await db.ref("users").get();
  const users = snap.val();

  if (users) {
    for (let key in users) {
      if (users[key].email === email) {
        if (users[key].provider === "local") {
          return res.status(400).json({
            error: "This email is already registered with password."
          });
        } else {
          return res.status(400).json({
            error: "Account already exists. Please login."
          });
        }
      }
    }
  }

  res.json({ needUsername: true });
}
