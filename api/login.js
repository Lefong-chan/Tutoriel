import admin from "firebase-admin";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const allowedOrigin = process.env.ALLOWED_ORIGIN;
const SECRET = process.env.JWT_SECRET;

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY)),
    databaseURL: "https://tutoriel-ff487-default-rtdb.firebaseio.com/"
  });
}

const db = admin.database();

export default async function handler(req, res) {

  if (req.headers.origin !== allowedOrigin) {
    return res.status(403).json({ error: "Forbidden origin" });
  }

  if (req.method !== "POST")
    return res.status(405).end();

  const { identifier, password } = req.body;

  if (!identifier || !password)
    return res.status(400).json({ error: "Missing fields" });

  let user = null;
  let userKey = null;

  // 1️⃣ Raha email
  if (identifier.includes("@")) {

    const emailKey = identifier
      .toLowerCase()
      .replace(/\./g, "_");

    const snap = await db.ref("users/" + emailKey).get();

    if (!snap.exists())
      return res.status(400).json({ error: "User not found" });

    user = snap.val();
    userKey = emailKey;

  } else {

    // 2️⃣ Raha name ➜ mikaroka ao anaty users rehetra
    const snap = await db.ref("users").get();

    if (!snap.exists())
      return res.status(400).json({ error: "No users found" });

    const users = snap.val();

    for (const key in users) {
      if (users[key].name.toLowerCase() === identifier.toLowerCase()) {
        user = users[key];
        userKey = key;
        break;
      }
    }

    if (!user)
      return res.status(400).json({ error: "User not found" });
  }

  const valid = await bcrypt.compare(password, user.password);

  if (!valid)
    return res.status(400).json({ error: "Wrong password" });

  const token = jwt.sign(
    { email: user.email },
    SECRET,
    { expiresIn: "2h" }
  );

  res.json({ token });
}
