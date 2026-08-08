'use strict';

const compression = require('compression');
const cors = require('cors');
const express = require('express');

const config = require('./config');
const logger = require('./logger');
const { createRouter } = require('./routes');

const corsOptions = config.cors.origins.includes('*')
  ? { origin: '*', methods: ['GET', 'HEAD'] }
  : { origin: config.cors.origins, methods: ['GET', 'HEAD'] };

/**
 * @param {{ gtfs: any, vehicles: any, alerts: any, klosok?: any, startedAt?: Date }} services
 */
const createApp = (services) => {
  const app = express();

  if (config.trustProxy) app.set('trust proxy', true);
  app.disable('x-powered-by');

  // Shapes are the largest responses by far and compress to a fraction of
  // their size, which matters a lot on mobile data.
  app.use(compression());
  app.use(cors(corsOptions));

  app.use(createRouter({ startedAt: new Date(), ...services }));

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found', path: req.path });
  });

  // Express identifies error handlers by arity, so `next` must stay declared.
  app.use((error, req, res, next) => {
    logger.error(`Unhandled error on ${req.method} ${req.path}:`, error);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
};

module.exports = { createApp };
