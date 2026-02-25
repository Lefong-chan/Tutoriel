export default async function handler(req, res) {
  const { code } = req.query;

  if (!code) {
    return res.status(400).json({ error: "No code provided" });
  }

  // Eto no exchange code → access_token (raha mila)

  // Redirect mankany app
  res.writeHead(302, {
    Location: `tompondaka105://login-success?code=${code}`,
  });
  res.end();
}
