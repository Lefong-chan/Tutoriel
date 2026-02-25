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

/* ===== Generate 9 digit UID ===== */
function generateUID() {
  return Math.floor(100000000 + Math.random() * 900000000).toString();
}

export default async function handler(req, res) {

  const { code } = req.query;

  if (!code) {
    return res.status(400).send("No code provided");
  }

  try {

    /* ===== 1️⃣ Exchange code → Google token ===== */
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: "https://tutoriel-theta.vercel.app/api/auth-callback"
      })
    });

    const tokenData = await tokenRes.json();

    if (!tokenData.id_token) {
      return res.status(400).send("Failed to get ID token");
    }

    /* ===== 2️⃣ Verify Google ID token ===== */
    const decoded = await admin.auth().verifyIdToken(tokenData.id_token);
    const email = decoded.email;

    if (!email) {
      return res.status(400).send("No email found");
    }

    const usersSnap = await db.ref("users").get();
    const users = usersSnap.val();

    let existingUser = null;

    if (users) {
      for (let key in users) {
        if (users[key].email === email) {
          existingUser = users[key];
          break;
        }
      }
    }

    let uidToUse;

    /* ===== 3️⃣ If user exists ===== */
    if (existingUser) {

      if (existingUser.provider !== "google") {
        return res.status(400).send("Email registered with password.");
      }

      uidToUse = existingUser.uid;

    } else {

      /* ===== Create new user ===== */
      let exists = true;

      while (exists) {
        uidToUse = generateUID();
        const check = await db.ref("users/" + uidToUse).get();
        if (!check.exists()) exists = false;
      }

      await db.ref("users/" + uidToUse).set({
        uid: uidToUse,
        email,
        provider: "google",
        createdAt: Date.now()
      });
    }

    /* ===== 4️⃣ Create JWT ===== */
    const token = jwt.sign(
      { uid: uidToUse, email },
      SECRET,
      { expiresIn: "2h" }
    );

    /* ===== 5️⃣ Redirect to Android App ===== */
    res.writeHead(302, {
      Location: `tompondaka105://login-success?token=${token}`
    });
    res.end();

  } catch (error) {

    console.error(error);
    res.status(500).send("Authentication failed");

  }
}
