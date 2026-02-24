import admin from "firebase-admin";
import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET;

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY)),
    databaseURL: "https://tutoriel-ff487-default-rtdb.firebaseio.com/"
  });
}

const db = admin.database();

export default async function handler(req, res) {

  try {

    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "No token provided" });
    }

    const token = authHeader.split(" ")[1];

    const decoded = jwt.verify(token, SECRET);

    const uid = decoded.uid;

    const snap = await db.ref("users/" + uid).get();

    if (!snap.exists()) {
      return res.status(404).json({ error: "User not found in database" });
    }

    const user = snap.val();

    return res.status(200).json({
      uid: user.uid,
      username: user.username,
      email: user.email
    });

  } catch (error) {

    return res.status(401).json({
      error: "Invalid or expired token"
    });
  }
}
