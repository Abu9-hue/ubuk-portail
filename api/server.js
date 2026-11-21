{
  "version": 2,
  "builds": [
    { "src": "server.js", "use": "@vercel/node" }
  ],
  "routes": [
    { "src": "/api/(.*)", "dest": "/server.js" },
    { "handle": "filesystem" }
  ]
}
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));
