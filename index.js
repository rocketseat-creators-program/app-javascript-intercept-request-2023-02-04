const path = require('path');
const express = require('express');
const axios = require('axios');
const elasticsearch = require('@elastic/elasticsearch');

class ElasticsearchLogger {
    constructor() {
        this.__logs = [];

        this.__originalConsole = {
            log: console.log,
            info: console.info,
            warn: console.warn,
            error: console.error,
            debug: console.debug,
        }

        this.__databaseClient = this.__configureDatabaseClient();

        this.__isPooling = false;
    }

    configure() {
        console.log = (message, data) => this.post(message, 'log', data);
        console.info = (message, data) => this.post(message, 'info', data);
        console.warn = (message, data) => this.post(message, 'warn', data);
        console.error = (message, data) => this.post(message, 'error', data);
        console.debug = (message, data) => this.post(message, 'debug', data);
    }

    post(message, level = 'log', data = undefined) {
        const log = {
            message,
            level,
            data,
            timestamp: new Date()
        };
        this.__logs.push(log);
        this.__pooling();

        this.__originalConsole[level](`[${log.timestamp.toISOString()}] ${log.level.padStart(5)}: ${message}`);
    }

    async __pooling() {
        if (this.__isPooling) return;
        this.__isPooling = true;

        const log = this.__logs.shift();
        if (log) {
            let interval = 1;
            try {
                await this.__saveToDatabase(log);
            } catch (error) {
                this.__originalConsole.error(`Ocorreu um erro ao enviar o log para o banco de dados. ${error?.message ?? error}`);
                interval = 30000;
                this.__logs.unshift(log);
            }
            setTimeout(() => this.__pooling(), interval);
        }

        this.__isPooling = false;
    }

    __configureDatabaseClient() {
        return new elasticsearch.Client({
            node: process.env.ELASTICSEARCH_NODE || 'http://20.206.97.76:9200',
            auth: {
                username: process.env.ELASTICSEARCH_USER || 'elastic',
                password: process.env.ELASTICSEARCH_PASS || 'my_password_for_elastic'
            }
        });
    }

    async __saveToDatabase(log) {
        const data = {};
        for (const key in log.data) {
            data[key] = ['string', 'number', 'boolean'].includes(typeof log.data[key])
                ? log.data[key].toString()
                : JSON.stringify(log.data[key]);
        }
        const index = `logs-${
            log.timestamp.getFullYear()
        }_${
            (log.timestamp.getMonth() + 1).toString().padStart(2, '0')
        }_${
            log.timestamp.getDate().toString().padStart(2, '0')
        }_${
            log.timestamp.getHours().toString().padStart(2, '0')
        }_${
            log.timestamp.getMinutes().toString().padStart(2, '0')
        }_${
            log.level
        }`;
        await this.__databaseClient.index({
            index,
            body: {
                message: log.message,
                level: log.level,
                data,
                timestamp: log.timestamp,
            }
        });
    }
}

class App {
    constructor() {
        this.__port = process.env.PORT || 3000;
        this.__express = express();
        this.__coins = [];
        this.__middleware();
        this.__routes();
        this.__loadData();
    }

    get __availableSymbols() {
        return this.__coins.map(coin => coin.symbol);
    }

    async __loadData() {
        const url = 'https://api2.binance.com/api/v3/ticker/24hr';
        const baseCoin = 'BUSD';
        console.log(`Carregando dados da API da Binance em: ${url}`, { url });
        try {
            const response = await axios.get(url);
            console.debug(`Recebido dados da API da Binance. Status ${response.status}, ${response.statusText}. Comprimento dos dados: ${JSON.stringify(response.data).length}`, {
                statusCode: response.status,
                statusText: response.statusText,
                data: JSON.stringify(response.data)
            });
            this.__coins = response.data
                .filter(coin =>
                    coin.lastPrice > 0 && (
                        coin.symbol.startsWith(baseCoin) ||
                        coin.symbol.endsWith(baseCoin)
                    )
                )
                .map(coin => ({
                    symbol: coin.symbol.replace(baseCoin, '').trim().toUpperCase(),
                    price: coin.symbol.startsWith(baseCoin) ? 1 / coin.lastPrice : Number(coin.lastPrice),
                }))
                .concat([{
                    symbol: baseCoin,
                    price: 1,
                    baseCoin: true
                }])
                .sort((a, b) => a.symbol.localeCompare(b.symbol));
                console.debug(`A lista de moedas foi atualizada com ${this.__coins.length} itens: ${this.__coins.map(coin => coin.symbol).join(', ')}`, {
                    coins: this.__coins,
                    coinsLength: this.__coins.length,
                    baseCoin
                });
        } catch (error) {
            console.error(`Ocorreu um erro ao consumir a API da Binance. ${error?.message ?? error}`, { error });
        }
    }

    __middleware() {
        this.__express.use(express.json());

        const wwwroot = path.join(__dirname, 'wwwroot');
        console.log(`O serviço HTTP está usando o diretório "${wwwroot}" como raiz.`, { wwwroot });
        this.__express.use(express.static(wwwroot));

        this.__express.use((req, res, next) => {
            res.on('finish', () => {
                if (res.statusCode >= 400) {
                    console.warn(`Resposta HTTP ${res.statusCode} para ${req.method} ${req.url}`, {
                        statusCode: res.statusCode,
                        method: req.method,
                        url: req.url
                    });
                } else {
                    console.debug(`Resposta HTTP ${res.statusCode} para ${req.method} ${req.url}`, {
                        statusCode: res.statusCode,
                        method: req.method,
                        url: req.url
                    });
                }
            })
            next();
        })
    }

    __routes() {
        this.__express.post('/api/log/:key', async (req, res) => {
            switch (req.params.key) {
                case 'frontpage':
                    console.log(`Página inicial carregada pelo usuário.`, {
                        action: 'log',
                        key: req.params.key
                    });
                    break;
                case 'ping':
                    console.log(`O usuário pingou o servidor.`, {
                        action: 'log',
                        key: req.params.key
                    });
                    break;
                default:
                    console.warn(`Recebido um evento de log desconhecido: ${req.params.key}`, {
                        action: 'log',
                        key: req.params.key
                    });
                    break;
            }
            res.status(200).send();
        });

        this.__express.get('/api/coins', async (req, res) => {
            res.json(this.__availableSymbols);
        });

        this.__express.get('/api/convert/:from/:ammount?/:to?', async (req, res) => {
            const from = String(req.params.from).toUpperCase().trim();
            const to = String(req.params.to ?? this.__coins.find(coin => coin.baseCoin).symbol).toUpperCase().trim();
            const ammount = Number(req.params.ammount ?? 1);

            if (this.__availableSymbols.length === 0) {
                console.warn(`Conversão não pode ser realizada pois a lista de moedas está vazia.`);
                res.status(500).json({ error: 'No coins available' });
            } else if (Number.isNaN(ammount)) {
                console.warn(`Conversão não pode ser realizada pois o valor da moeda é inválido: ${req.params.ammount}`, {
                    ammount: req.params.ammount
                });
                res.status(400).json({ error: 'Ammount must be a number' });
            } else if (!this.__availableSymbols.includes(from) || !this.__availableSymbols.includes(to)) {
                console.warn(`Conversão não pode ser realizada pois a moeda ${from} ou ${to} não está disponível.`, {
                    from,
                    to
                });
                res.status(400).json({ error: `Symbol must be one of: ${this.__availableSymbols.join(', ')}` });
            } else {
                const fromPrice = this.__coins.find(coin => coin.symbol === from).price;
                const toPrice = this.__coins.find(coin => coin.symbol === to).price;
                const result = (ammount * fromPrice / toPrice).toFixed(8);
                console.log(`Convertendo ${ammount} ${from} para ${to} = ${result}`, {
                    ammount,
                    from,
                    to,
                    result,
                    action: 'convert'
                });
                res.json({result});
            }
        });
    }

    start() {
        this.__express.listen(this.__port, () => {
            console.log(`O serviço HTTP foi ligado na porta ${this.__port}.`, { 
                port: this.__port
            });
        });
    }
}

try {
    // new ElasticsearchLogger().configure();
} catch (error) {
    console.error(`Ocorreu um erro ao configurar o ElasticsearchLogger. ${error?.message ?? error}`, { error });
}

try {
    console.info(`Aplicação iniciada.`);
    new App().start();
} catch (error) {
    console.error(`Ocorreu um erro não tratado durante a execução da aplicação. A aplicação será finalizada. ${error?.message ?? error}`, { error });
}
