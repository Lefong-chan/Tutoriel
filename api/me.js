import admin from "firebase-admin";
import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET;

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_KEY)
    ),
    databaseURL: "https://tutoriel-ff487-default-rtdb.firebaseio.com/"
  });
}

const db = admin.database();

export default async function handler(req, res) {

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {

    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({ error: "No token provided" });
    }

    const token = authHeader.split(" ")[1];

    const decoded = jwt.verify(token, SECRET);

    const snap = await db.ref("users/" + decoded.uid).get();

    if (!snap.exists()) {
      return res.status(404).json({ error: "User not found" });
    }

    return res.json(snap.val());

  } catch (error) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}
