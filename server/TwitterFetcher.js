const { TwitterApi } = require('twitter-api-v2');
const fetch = require('node-fetch');
require('dotenv').config();

class TwitterFetcher {
    constructor({ username, intervalMinutes = 15, userId = null }) {
        this.username = username;
        this.interval = intervalMinutes * 60 * 1000;
        this.client = new TwitterApi(process.env.TWITTER_BEARER_TOKEN);
        this.bearerToken = process.env.TWITTER_BEARER_TOKEN;
        this.userId = userId || null;
        this.tweets = [];
        this.alerts = [];
        this.timer = null;
    }

    async init() {
        try {
            if (!this.userId) {
                const user = await this.client.v2.userByUsername(this.username);
                this.userId = user.data.id;
                console.log(`Fetched user ID for ${this.username}: ${this.userId}`);
            } else {
                console.log(`Using provided user ID: ${this.userId}`);
            }

            await this.updateTweets();
            this.timer = setInterval(() => this.updateTweets(), this.interval);
        } catch (error) {
            console.error('Failed to initialize TwitterFetcher:', error);
        }
    }

    async updateTweets() {
        if (!this.userId) return;

        const url = `https://api.twitter.com/2/users/${this.userId}/tweets?tweet.fields=created_at,public_metrics`;
        try {
            const response = await fetch(url, {
                headers: {
                    'Authorization': `Bearer ${this.bearerToken}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

            const data = await response.json();
            const tweets = (data.data || []);

            this.tweets = tweets.map(tweet => ({
                id: tweet.id,
                text: tweet.text,
                created_at: tweet.created_at,
                public_metrics: tweet.public_metrics
            }));

            this.alerts = this.tweets.map((tweet, index) => ({
                id: index + 1, // or tweet.id if you prefer
                content: tweet.text,
                timestamp: new Date(tweet.created_at).getTime(),
                affected: this.extractAffectedLines(tweet.text)
            }));

            console.log(`[${new Date().toLocaleTimeString()}] Updated ${this.tweets.length} tweets.`);
        } catch (error) {
            console.error('Error fetching tweets:', error);
        }
    }

    extractAffectedLines(content) {
        const matches = content.match(/(?:linia|linii)\s+(\d+)/gi);
        return matches ? matches.map(m => m.match(/\d+/)[0]) : [];
    }

    getAlerts(fromTimestamp = 0) {
        return this.alerts.filter(alert => alert.timestamp >= fromTimestamp);
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
    }
}

module.exports = TwitterFetcher;
