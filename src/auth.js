const jwt = require('jsonwebtoken');
const { db, logActivity } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

function signToken(employee) {
  return jwt.sign(
    { id: employee.id, email: employee.email, role: employee.role, name: employee.full_name },
    JWT_SECRET,
    { expiresIn: '12h' }
  );
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'unauthorized', message: 'Missing token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'unauthorized', message: 'Invalid or expired token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'forbidden', message: 'You are not authorized to perform this action.' });
    }
    next();
  };
}

module.exports = { signToken, authMiddleware, requireRole, JWT_SECRET };
