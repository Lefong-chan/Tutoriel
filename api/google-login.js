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

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {

    const { idToken } = req.body;

    if (!idToken) {
      return res.status(400).json({ error: "Missing token" });
    }

    const decoded = await admin.auth().verifyIdToken(idToken);

    const firebaseUid = decoded.uid;
    const email = decoded.email;

    if (!email) {
      return res.status(400).json({ error: "No email found" });
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

    if (existingUser) {

      if (existingUser.provider !== "google") {
        return res.status(400).json({
          error: "This email is registered with password login."
        });
      }

      uidToUse = existingUser.uid;

    } else {

      uidToUse = firebaseUid;

      await db.ref("users/" + uidToUse).set({
        uid: uidToUse,
        email: email,
        provider: "google",
        createdAt: Date.now()
      });

    }

    const token = jwt.sign(
      { uid: uidToUse, email },
      SECRET,
      { expiresIn: "2h" }
    );

    return res.json({
      success: true,
      token
    });

  } catch (error) {

    console.error(error);

    return res.status(401).json({
      error: "Invalid Google token"
    });
  }
      }
