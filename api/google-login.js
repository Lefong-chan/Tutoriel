import admin from "firebase-admin";
import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET;

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_KEY)
    )
  });
}

export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { idToken } = req.body;

  if (!idToken) {
    return res.status(400).json({ error: "Missing token" });
  }

  try {

    const decoded = await admin.auth().verifyIdToken(idToken);

    const token = jwt.sign(
      { uid: decoded.uid },
      SECRET,
      { expiresIn: "2h" }
    );

    return res.json({ token });

  } catch (error) {
    return res.status(401).json({ error: "Invalid Google token" });
  }
}
