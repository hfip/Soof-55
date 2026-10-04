module.exports = {
  apps: [{ name: 'soof-55', script: 'server.js', node_args: '--env-file-if-exists=.env', env: { NODE_ENV: 'production' } }]
};
