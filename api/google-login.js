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
    
    const { uid, email, name } = req.body;
    
    if (!uid || !email) {
      return res.status(400).json({ error: "Missing data" });
    }
    
    const userRef = db.ref("users/" + uid);
    const snap = await userRef.get();
    
    if (!snap.exists()) {
      
      await userRef.set({
        uid: uid,
        username: name || "Google User",
        email: email,
        createdAt: Date.now()
      });
      
    }
    
    const token = jwt.sign({ uid }, SECRET, { expiresIn: "7d" });
    
    return res.json({ token });
    
  } catch (error) {
    return res.status(500).json({ error: "Server error" });
  }
}
