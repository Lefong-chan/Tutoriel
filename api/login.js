import admin from "firebase-admin";
import bcrypt from "bcryptjs";
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

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password required" });
  }

  try {

    const snap = await db.ref("users").get();
    const users = snap.val();

    if (!users) {
      return res.status(400).json({ error: "User not found" });
    }

    let foundUser = null;

    for (let key in users) {
      if (users[key].email === email) {
        foundUser = users[key];
        break;
      }
    }

    if (!foundUser) {
      return res.status(400).json({ error: "User not found" });
    }

    if (foundUser.provider !== "local") {
      return res.status(400).json({
        error: "This account uses Google login."
      });
    }

    const isMatch = await bcrypt.compare(password, foundUser.password);

    if (!isMatch) {
      return res.status(400).json({ error: "Invalid password" });
    }

    // Create JWT
    const token = jwt.sign(
      { uid: foundUser.uid, email: foundUser.email },
      SECRET,
      { expiresIn: "2h" }
    );

    return res.json({ token });

  } catch (error) {
    return res.status(500).json({ error: "Server error" });
  }
  }
