const databaseSwitchService = require('../services/database-switch.service');

class AdminDatabaseController {
  /**
   * GET /api/admin/database/config
   * Returns current active database and sanitized configuration without secrets.
   */
  async getConfig(req, res, next) {
    try {
      const config = databaseSwitchService.getConfig();
      res.status(200).json(config);
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/admin/database/status
   * Returns connection status, health check metrics, and latency for configured databases.
   */
  async getStatus(req, res, next) {
    try {
      const status = await databaseSwitchService.getStatus();
      res.status(200).json(status);
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/admin/database/test-connection
   * Tests connection to a specific database candidate without activating it.
   */
  async testConnection(req, res, next) {
    try {
      const { databaseType } = req.body;
      const result = await databaseSwitchService.testConnection(databaseType);
      const statusCode = result.ok ? 200 : 400;
      res.status(statusCode).json(result);
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/admin/database/switch
   * Validates and atomically switches the active database.
   */
  async switchDatabase(req, res, next) {
    try {
      const { databaseType } = req.body;
      const adminUser = req.user || { username: 'admin' };
      const result = await databaseSwitchService.switchDatabase(databaseType, adminUser);
      res.status(200).json(result);
    } catch (err) {
      const statusCode = err.status || 500;
      res.status(statusCode).json({
        ok: false,
        error: err.message,
        details: err.details || 'Check your database connection settings in .env',
      });
    }
  }

  /**
   * GET /api/admin/database/switch-history
   * Retrieves audit log of past database switches.
   */
  async getSwitchHistory(req, res, next) {
    try {
      const history = databaseSwitchService.getSwitchHistory();
      res.status(200).json({ history });
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new AdminDatabaseController();
