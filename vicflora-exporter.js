const fs = require('fs').promises;
const path = require('path');

class VicFloraExporter {
  constructor(outputDir = './vicflora-data') {
    this.outputDir = outputDir;
  }

  async ensureOutputDir() {
    await fs.mkdir(this.outputDir, { recursive: true });
  }

  async exportToJSON(data, filename) {
    await this.ensureOutputDir();
    const filepath = path.join(this.outputDir, `${filename}.json`);
    await fs.writeFile(filepath, JSON.stringify(data, null, 2));
    console.log(`Exported to ${filepath}`);
    return filepath;
  }

  async exportCompleteKey(keyData) {
    const keyId = keyData.metadata?.id || 'unknown';
    const keyTitle = keyData.title || 'Unknown Key';

    console.log(`\nExporting complete data for ${keyTitle} (ID: ${keyId})`);
    return {
      json: await this.exportToJSON(keyData, `key-${keyId}-complete`)
    };
  }
}

module.exports = VicFloraExporter;
