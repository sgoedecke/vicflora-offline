# How to Use the VicFlora Plant Identification CLI

## Quick Start

1. **First, scrape the keys** (if you haven't already):
   ```bash
   npm run scrape:multi
   npm run scrape:identification
   ```

2. **Start the interactive identification**:
   ```bash
   npm run key          # multi-access keys
   npm run key:dichotomous  # dichotomous (KeyBase) keys
   ```

## Example Session

Here's what a typical identification session looks like:

```
🌿 VicFlora Interactive Plant Identification Key
===============================================

🔑 Available identification keys:

1. Multiaccess key to families of flowering plants in Victoria
2. Multiaccess key to the Fabaceae of Victoria
3. Key to Brassicaceae in Victoria
4. Multiaccess key to the Juncaceae of Victoria
5. Multiaccess key to the Cyperaceae of Victoria
6. Key to the eucalypts of Victoria

Select a key (number): 2

🌿 Multiaccess key to the Fabaceae of Victoria
📊 310 taxa, 62 characters
🎯 Starting with 178 possible taxa

📋 Select a character to examine (178 taxa remaining):

1. 🔢 Plant habit
2. 🔢 Spines
3. 🔢 Branchlet cross-section
4. 🔢 Leaf arrangement
5. 🔢 Leaf type
...
19. ❌ Quit keying

Select character (number): 1

🔍 Plant habit
1. Tree 📷 ℹ️
2. Erect to ascending shrub 📷 ℹ️
3. Prostrate or decumbent shrub 📷 ℹ️
4. Climbing, twining or straggling 📷 ℹ️
5. Rosette-forming or herbaceous 📷 ℹ️
6. ⬅️  Back to character selection

What do you observe? 1

✅ Selected: Plant habit = Tree
📉 Eliminated 150 taxa, 28 remaining

📋 Select a character to examine (28 taxa remaining):
...

🎯 IDENTIFIED: Acacia melanoxylon (Blackwood)
Taxon ID: 123
```

## Dichotomous Key Session

After exporting KeyBase data you can navigate a traditional dichotomous key. The CLI walks through the lead tree and reports the matching taxon.

```
🌱 VicFlora Dichotomous Key
🔑 Key to the species of Acacia
📚 Scope: Acacia

==================================================
1. Mature leaves bipinnate
   → Acacia dealbata
2. Mature leaves modified into phyllodes (either flat, spiny or needle-like) or absent

Choose an option (b=back, r=restart, q=quit): 2

==================================================
1. Phyllodes bluish, waxy; glands absent
   → Acacia cultriformis
2. Phyllodes green; glands present on upper edge or between marginal veins

Choose an option (b=back, r=restart, q=quit): 1

--------------------------------------------------
🎉 Result: Acacia cultriformis
🔗 https://vicflora.rbg.vic.gov.au/flora/taxon/76abff97-353c-4dcb-9c1b-a4beacdd8371
--------------------------------------------------

Press Enter to continue from here, or type r to restart, q to quit: q
```

## Key Features

### Icons Explained
- 🔢 **Discrete character**: Choose from a list of options
- 📏 **Numeric character**: Measurement-based (not yet supported in CLI)
- 📷 **Has images**: Character state includes reference images
- ℹ️ **Has info**: Character state includes additional information
- ✅ **Selected**: You've chosen this character state
- 📉 **Progress**: Shows taxa eliminated
- 🎯 **Identified**: Final result when down to one species

### Navigation
- **Numbers 1-X**: Select characters or states
- **0 or "Back"**: Return to previous menu
- **Quit option**: Exit the keying process
- **Invalid input**: System will ask again

### Tips for Success

1. **Start with obvious characters**: Look for easily observable features like plant habit, leaf arrangement, or flower color

2. **Use images when available**: The 📷 icon means reference images are available (though not displayed in CLI)

3. **Don't worry about order**: Unlike traditional keys, you can observe characters in any order

4. **Variable taxa**: Some plants will match multiple states (coded as "variable" in the data)

5. **Continue until certain**: Keep narrowing down until you have 1-5 candidates, then examine those species manually

## Available Keys

- **Fabaceae** (310 taxa): Pea family - acacias, peas, clovers
- **Brassicaceae** (107 taxa): Mustard family - mustards, watercress
- **Eucalypts** (159 taxa): Eucalyptus trees and mallees
- **Cyperaceae** (206 taxa): Sedge family - sedges, rushes
- **Juncaceae** (62 taxa): Rush family - true rushes
- **Flowering Plant Families** (167 taxa): Family-level identification

## Troubleshooting

**"No key files found"**: Run `npm run scrape:multi` first

**"Readline was closed"**: This was a bug in the original version, should be fixed now

**"No taxa match"**: You may have made an error - some character combinations are impossible

**"Numeric character not supported"**: The CLI doesn't handle measurement-based characters yet

Enjoy identifying plants! 🌿🔍
