try {
  require('./cleanup.js').register(process.env);
} catch (error) {
  console.error(`::error::Could not register job cleanup: ${error.message}`);
  process.exitCode = 1;
}
