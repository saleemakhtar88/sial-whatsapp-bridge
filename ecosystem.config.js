// PM2 config for the WhatsApp bridge.
// When copying into AeroERP, add this app block to the ERP's ecosystem.config.js
// alongside aeroerp-api and aeroerp-frontend.
module.exports = {
  apps: [
    {
      name: 'aeroerp-whatsapp',
      script: 'src/server.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_restarts: 15,
      min_uptime: '10s',
      max_memory_restart: '700M',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
