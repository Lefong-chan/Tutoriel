import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET;

export default function handler(req, res) {

  const auth = req.headers.authorization;
  if (!auth) return res.status(401).end();

  const token = auth.split(" ")[1];

  try {
    const decoded = jwt.verify(token, SECRET);
    res.json({ username: decoded.username });
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}
