const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
require('dotenv').config();

const prisma = require('./src/config/prisma');

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/api/health', (req, res) => {
  res.json({ status: 'Backend is running' });
});

const authRoutes = require('./src/routes/auth.routes');
app.use('/api/auth', authRoutes);

const errorHandler = require('./src/middleware/errorHandler');
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

prisma
  .$connect()
  .then(() => {
    console.log('Database connection OK');
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Unable to connect to database:', err.message);
    process.exit(1);
  });
