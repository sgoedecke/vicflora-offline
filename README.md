# VicFlora Key Scraper

A comprehensive scraper for extracting dichotomous keys and multi-access keys from VicFlora (Victoria's flora database).

## Features

- **Multi-Access Keys**: Downloads and parses Lucid JS bundles with full character matrices
- **Identification Keys**: Discovers dichotomous key metadata and downloads full KeyBase JSON exports
- **LZ-String Decompression**: Handles compressed character state data
- **Multiple Export Formats**: JSON and CSV exports
- **Rate Limiting**: Gentle on the VicFlora servers with built-in delays
- **Error Handling**: Robust retry logic and graceful error handling

## Installation

```bash
npm install
```

## Usage

### 1. Scraping Keys

```bash
# Scrape all multi-access keys
node main.js multi-access

# Discover identification keys and download KeyBase exports
node main.js identification

# Scrape everything
node main.js all

# List available keys without downloading
node main.js list

# Analyze a specific key
node main.js analyze fabaceae
```

### 2. Interactive Plant Identification

After scraping, use the keys to identify plants:

```bash
# Start multi-access keying session
npm run key

# Start dichotomous key session (requires KeyBase exports)
npm run key:dichotomous
```

The keying CLI will:
1. Show available identification keys
2. Let you select a key (e.g., Fabaceae, Brassicaceae)
3. Guide you through character selection
4. Eliminate taxa based on your observations
5. Continue until you identify a single species

Example session:
```
🌿 VicFlora Interactive Plant Identification Key
Select a key: 2 (Fabaceae)

🔍 Plant habit?
  1. Tree 📷 ℹ️
  2. Erect to ascending shrub 📷 ℹ️
  3. Prostrate or decumbent shrub 📷 ℹ️
Select: 1

✅ Selected: Plant habit = Tree
📉 Eliminated 280 taxa, 30 remaining

🔍 Leaf type?
  1. Simple or with one leaflet 📷 ℹ️
  2. Pinnate, with more than 3 leaflets 📷 ℹ️
Select: 2

🎯 IDENTIFIED: Acacia melanoxylon (Blackwood)
```

### NPM Scripts

```bash
npm run scrape:multi        # Multi-access keys only
npm run scrape:identification  # Identification keys only
npm run scrape:all          # Everything
npm run list               # List keys
npm run key                # Interactive plant identification
```

## Data Structure

### Multi-Access Keys

Multi-access keys are downloaded from CDN locations like:
`https://vicflora-cdn.rbg.vic.gov.au/lucid-keys/fabaceae.js`

The scraper:
1. Strips the JavaScript wrapper (`var key = ...`)
2. Parses the JSON payload
3. Decompresses LZ-string encoded character matrices
4. Exports structured data

**Key data includes:**
- `entities`: Taxa/species information
- `features`: Character definitions with hierarchy
- `states`: Character state definitions
- `scores`: Character-state matrix (decompressed)
- `measures`: Continuous character measurements (decompressed)

### Identification Keys

Identification keys are discovered through multiple strategies:
- Brute force ID enumeration
- NUXT payload extraction from web pages
- Solr search attempts
- KeyBase export downloads (`https://keybase.rbg.vic.gov.au/keys/export/{id}?format=json`)

KeyBase exports include the full dichotomous lead structure (`leads`, `items`, and the starting `first_step`), enabling offline navigation of the keys.

## Export Formats

### JSON Exports
- `all-multi-access-keys.json`: Complete data for all keys
- `key-{id}-complete.json`: Individual key data
- `all-identification-keys.json`: Discovered identification keys (metadata)
- `identification-key-{id}.json`: Combined KeyBase export and GraphQL metadata per key

### CSV Exports
- `multi-access-keys-summary.csv`: Overview of all multi-access keys
- `identification-keys-summary.csv`: Overview of identification keys (metadata)
- `character-matrix-{id}.csv`: Character-state matrices
- `character-definitions-{id}.csv`: Character and state definitions
- `measurements-{id}.csv`: Continuous character measurements

## Technical Details

### GraphQL Queries Used

```graphql
# List all multi-access keys
query {
  multiAccessKeys {
    id
    title
    location
  }
}

# Get key metadata
query($id: ID!) {
  multiAccessKey(id: $id) {
    id
    title
    description
    characters {
      id
      name
      type
      characterType
      description
      states {
        id
        name
        description
      }
    }
  }
}

# Try identification key
query($id: ID!) {
  identificationKey(id: $id) {
    id
    title
    taxonomicScope
    geographicScope
    created
    modified
  }
}
```

### Data Decompression

Character matrices are compressed using LZ-string in base64 format. The scraper includes a custom LZ-string implementation to decompress:

- **Scores**: Character presence/absence data (0/1/2 values)
- **Measures**: Continuous measurement ranges (colon-delimited)

## API Rate Limits

The scraper implements:
- 1-second delays between requests
- Exponential backoff for failures
- Maximum 3 retry attempts
- Connection reset handling

## Current Limitations

1. **Identification Keys**: Schema introspection shows limited fields. The actual key content structure is not yet discovered.

2. **Matrix Keys**: The `matrixKey(path: String!)` query exists but requires proper path discovery.

3. **NUXT Payload**: Web pages contain extensive data in `window.__NUXT__` but require JavaScript execution to access.

## How Plant Identification Works

The keying process uses **multi-access keys** (also called matrix keys) which are more flexible than traditional dichotomous keys:

### Traditional Dichotomous Keys
- Fixed sequence: 1a vs 1b → 2a vs 2b → etc.
- Must observe characters in predetermined order
- Dead end if you can't see a required character

### Multi-Access Keys
- Choose any character you can observe
- System eliminates incompatible taxa automatically
- More flexible and user-friendly
- Handles missing/uncertain observations

### The Algorithm

1. **Start** with all taxa in the dataset
2. **Select** a character you can observe (habit, leaf shape, flower color, etc.)
3. **Choose** the state you observe for that character
4. **Eliminate** all taxa that don't match (accounting for variable/unknown states)
5. **Repeat** with remaining taxa until you have a single match

### Character States

- **0** = Character state absent
- **1** = Character state present
- **2** = Variable (taxon can have multiple states)
- **4** = Unknown/not scored

The system treats variable (2) and unknown (4) states as potential matches, making identification more robust in real-world conditions.

## Contributing

To extend the scraper:

1. **Add New Key Types**: Implement new scraper classes following the pattern
2. **Improve Discovery**: Enhance identification key discovery methods
3. **Add Export Formats**: Extend the exporter with new output formats
4. **Handle More Data**: Parse additional fields from the Lucid bundles

## Example Output

```
=== VicFlora Multi-Access Key Scraper ===

Fetching list of multi-access keys...
Found 15 multi-access keys
Downloading Fabaceae from https://vicflora-cdn.rbg.vic.gov.au/lucid-keys/fabaceae.js
✓ Successfully processed Fabaceae
...

=== Export Results ===
Successfully scraped 15 multi-access keys
Exported to ./vicflora-data/all-multi-access-keys.json
Exported summary to ./vicflora-data/multi-access-keys-summary.csv

=== Analysis ===
Fabaceae:
  Entities: 310 (178 scored)
  Characters: 87 ({"discrete":85,"grouping":2})
  States: 324
```

## License

MIT License - Use responsibly and respect VicFlora's terms of service.
