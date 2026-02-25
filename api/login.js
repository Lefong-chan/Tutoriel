import admin from "firebase-admin";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET;
const allowedOrigin = process.env.ALLOWED_ORIGIN;

if (!SECRET) {
  throw new Error("JWT_SECRET is not defined in environment variables");
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_KEY)
    ),
    databaseURL:
      "https://tutoriel-ff487-default-rtdb.firebaseio.com/"
  });
}

const db = admin.database();

export default async function handler(req, res) {

  // Allow only POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (allowedOrigin && req.headers.origin !== allowedOrigin) {
    return res.status(403).json({ error: "Forbidden origin" });
  }

  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password required" });
  }

  try {

    const snap = await db
      .ref("users")
      .orderByChild("email")
      .equalTo(email)
      .limitToFirst(1)
      .get();

    if (!snap.exists()) {
      return res.status(400).json({ error: "User not found" });
    }

    const users = snap.val();
    const foundUser = Object.values(users)[0];

    if (foundUser.provider !== "local") {
      return res.status(400).json({
        error: "This account uses Google login."
      });
    }

    const isMatch = await bcrypt.compare(
      password,
      foundUser.password
    );

    if (!isMatch) {
      return res.status(400).json({ error: "Invalid password" });
    }

    // Create JWT
    const token = jwt.sign(
      {
        uid: foundUser.uid,
        email: foundUser.email
      },
      SECRET,
      { expiresIn: "2h" }
    );

    return res.status(200).json({
      success: true,
      token
    });

  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({
      error: "Server error"
    });
  }
}
