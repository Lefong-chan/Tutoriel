import admin from "firebase-admin";
import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET;

if (!SECRET) {
  throw new Error("JWT_SECRET not set");
}

if (!process.env.FIREBASE_KEY) {
  throw new Error("FIREBASE_KEY not set");
}

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

  if (serviceAccount.private_key) {
    serviceAccount.private_key =
      serviceAccount.private_key.replace(/\\n/g, "\n");
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL:
      "https://tutoriel-ff487-default-rtdb.firebaseio.com/"
  });
}

const db = admin.database();

export default async function handler(req, res) {

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {

    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "No token provided" });
    }

    const token = authHeader.split(" ")[1];

    const decoded = jwt.verify(token, SECRET);

    const snap = await db.ref("users/" + decoded.uid).get();

    if (!snap.exists()) {
      return res.status(404).json({ error: "User not found" });
    }

    const userData = snap.val();

    return res.status(200).json({
      uid: userData.uid,
      email: userData.email || null,
      phone: userData.phone || null
    });

  } catch (error) {
    return res.status(401).json({
      error: "Invalid or expired token"
    });
  }
        }
