export default async function handler(req, res) {
  const { code } = req.query;

  if (!code) {
    return res.status(400).send("No code provided");
  }

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: "https://tutoriel-theta.vercel.app/api/auth-callback",
        grant_type: "authorization_code",
      }),
    });

    const data = await tokenRes.json();

    if (!data.id_token) {
      return res.status(400).send("Failed to get ID token");
    }

    res.writeHead(302, {
      Location: `tompondaka105://login-success?id_token=${data.id_token}`,
    });
    res.end();
  } catch (err) {
    res.status(500).send("Server error");
  }
}
