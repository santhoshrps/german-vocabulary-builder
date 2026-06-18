# german-vocabulary-builder
Script to create the vocabulary from the CSV files in compliance with the data set in Cloudflare. 




Files created:

File	Purpose
.gitignore	Excludes data/, sync/.env, node_modules, .wrangler
schema/init.sql	D1 schema for all 3 tables
worker/wrangler.toml	Wrangler config — fill in your database_id
worker/package.json	Worker deps (wrangler, typescript, workers-types)
worker/tsconfig.json	TS config for Workers runtime
worker/src/index.ts	Worker API — auth, GET /state/:table, POST /sync/:table
sync/requirements.txt	Python deps
sync/.env.example	Env var template
sync/sync.py	Main sync script
To get started:


# 1. Create D1 database (copy the database_id into worker/wrangler.toml)
wrangler d1 create german-vocabulary

# 2. Apply schema
wrangler d1 execute german-vocabulary --file=schema/init.sql

# 3. Set API key secret
wrangler secret put API_KEY   # paste output of: openssl rand -hex 32

# 4. Deploy worker
cd worker && npm install && npm run deploy

# 5. Set up Python env
cd ../sync && python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# 6. Place Excel files in data/ and run
python sync.py