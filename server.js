require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GitHubStrategy = require('passport-github2').Strategy;
const path = require('path');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory database
const db = {
  users: [],
  discussions: [],
  comments: [],
  nextUserId: 1,
  nextDiscussionId: 1,
  nextCommentId: 1
};

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'atrium-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
  const user = db.users.find(u => u.id === id);
  done(null, user || null);
});

passport.use(new GitHubStrategy({
  clientID: process.env.GITHUB_CLIENT_ID,
  clientSecret: process.env.GITHUB_CLIENT_SECRET,
  callbackURL: `${process.env.BASE_URL}/auth/github/callback`
}, (accessToken, refreshToken, profile, done) => {
  let user = db.users.find(u => u.githubId === profile.id);
  if (!user) {
    user = {
      id: db.nextUserId++,
      githubId: profile.id,
      name: profile.displayName || profile.username,
      handle: profile.username,
      avatar: profile.photos && profile.photos[0] ? profile.photos[0].value : null,
      bio: '',
      location: '',
      website: '',
      profileComplete: false,
      createdAt: Date.now()
    };
    db.users.push(user);
  }
  return done(null, user);
}));

// Auth routes
app.get('/auth/github', passport.authenticate('github', { scope: ['user:email'] }));

app.get('/auth/github/callback',
  passport.authenticate('github', { failureRedirect: '/?error=auth_failed' }),
  (req, res) => {
    if (!req.user.profileComplete) {
      return res.redirect('/?setup=true');
    }
    res.redirect('/');
  }
);

app.get('/auth/logout', (req, res) => {
  req.logout(() => res.redirect('/'));
});

// API: get current user
app.get('/api/me', (req, res) => {
  if (!req.isAuthenticated()) return res.json({ user: null });
  res.json({ user: req.user });
});

// API: complete profile setup
app.post('/api/profile/setup', (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Unauthorized' });
  const { name, handle, bio, location, website } = req.body;
  if (!name || !handle) return res.status(400).json({ error: 'Name and handle are required' });
  const handleTaken = db.users.find(u => u.handle === handle && u.id !== req.user.id);
  if (handleTaken) return res.status(400).json({ error: 'This handle is already taken' });
  req.user.name = name;
  req.user.handle = handle;
  req.user.bio = bio || '';
  req.user.location = location || '';
  req.user.website = website || '';
  req.user.profileComplete = true;
  res.json({ success: true, user: req.user });
});

// API: update profile
app.put('/api/profile', (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Unauthorized' });
  const { name, bio, location, website } = req.body;
  if (name) req.user.name = name;
  if (bio !== undefined) req.user.bio = bio;
  if (location !== undefined) req.user.location = location;
  if (website !== undefined) req.user.website = website;
  res.json({ success: true, user: req.user });
});

// API: get all discussions
app.get('/api/discussions', (req, res) => {
  const discussions = db.discussions
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(d => ({
      ...d,
      commentCount: db.comments.filter(c => c.discussionId === d.id).length
    }));
  res.json(discussions);
});

// API: get single discussion
app.get('/api/discussions/:id', (req, res) => {
  const discussion = db.discussions.find(d => d.id === parseInt(req.params.id));
  if (!discussion) return res.status(404).json({ error: 'Not found' });
  res.json(discussion);
});

// API: create discussion
app.post('/api/discussions', (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Unauthorized' });
  const { title, content, category } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'Title and content are required' });
  const discussion = {
    id: db.nextDiscussionId++,
    title,
    content,
    category: category || 'general',
    author: req.user.name,
    authorHandle: req.user.handle,
    authorAvatar: req.user.avatar,
    authorId: req.user.id,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  db.discussions.push(discussion);
  res.json(discussion);
});

// API: delete discussion (owner only)
app.delete('/api/discussions/:id', (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Unauthorized' });
  const idx = db.discussions.findIndex(d => d.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  if (db.discussions[idx].authorId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  db.discussions.splice(idx, 1);
  res.json({ success: true });
});

// API: get comments for discussion
app.get('/api/discussions/:id/comments', (req, res) => {
  const comments = db.comments
    .filter(c => c.discussionId === parseInt(req.params.id))
    .sort((a, b) => a.createdAt - b.createdAt);
  res.json(comments);
});

// API: add comment
app.post('/api/discussions/:id/comments', (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Unauthorized' });
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'Content required' });
  const discussion = db.discussions.find(d => d.id === parseInt(req.params.id));
  if (!discussion) return res.status(404).json({ error: 'Discussion not found' });
  const comment = {
    id: db.nextCommentId++,
    discussionId: parseInt(req.params.id),
    content,
    author: req.user.name,
    authorHandle: req.user.handle,
    authorAvatar: req.user.avatar,
    authorId: req.user.id,
    createdAt: Date.now()
  };
  db.comments.push(comment);
  res.json(comment);
});

// API: delete comment (owner only)
app.delete('/api/comments/:id', (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Unauthorized' });
  const idx = db.comments.findIndex(c => c.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  if (db.comments[idx].authorId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  db.comments.splice(idx, 1);
  res.json({ success: true });
});

app.use(express.static(__dirname));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
