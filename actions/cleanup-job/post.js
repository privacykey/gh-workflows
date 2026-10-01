try {
  process.exitCode = require('./cleanup.js').cleanup(process.env);
} catch (error) {
  console.error(`::error::Job cleanup refused: ${error.message}`);
  process.exitCode = 1;
}
