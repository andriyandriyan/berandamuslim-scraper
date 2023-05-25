"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const youtube_1 = require("@googleapis/youtube");
const axios_1 = __importDefault(require("axios"));
const dotenv = __importStar(require("dotenv"));
const fastify_1 = __importDefault(require("fastify"));
const luxon_1 = require("luxon");
const nanoid_1 = require("nanoid");
const node_telegram_bot_api_1 = __importDefault(require("node-telegram-bot-api"));
const prisma_1 = __importDefault(require("./plugins/prisma"));
dotenv.config();
const app = (0, fastify_1.default)({
    logger: process.env.NODE_ENV === 'development',
});
app.register(prisma_1.default);
app.get('/', () => ({ hello: 'world' }));
app.get('/articles', async (request, reply) => {
    const { prisma } = app;
    const perPage = 10;
    const sources = await prisma.source.findMany({
        where: {
            deletedAt: null,
        },
        include: {
            _count: {
                select: {
                    articles: {
                        where: {
                            deletedAt: null,
                        },
                    },
                },
            },
        },
    });
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const data = await prisma.$transaction(async (trx) => {
        const getPosts = [];
        const storePosts = [];
        sources.forEach(source => {
            getPosts.push(new Promise(async (resolve, reject) => {
                const baseURL = `https://${source.url}`;
                const url = 'wp-json/wp/v2/posts';
                const config = {
                    headers: { 'Accept-Encoding': 'gzip,deflate,compress' },
                    baseURL,
                };
                const { headers } = await axios_1.default.get(url, {
                    ...config,
                    params: {
                        _fields: ['id'],
                        per_page: 1,
                    },
                });
                const total = Number(headers['x-wp-total'] || 0);
                const articlesCount = source._count.articles;
                if (total === articlesCount) {
                    return resolve({ source, posts: [] });
                }
                const lastPage = Math.ceil(articlesCount / perPage);
                const mod = articlesCount % perPage;
                const page = mod > 0 ? lastPage : lastPage + 1;
                await trx.source.update({
                    data: { articleSourcesCount: total },
                    where: { id: source.id },
                });
                try {
                    const { data } = await axios_1.default.get(url, {
                        ...config,
                        params: {
                            orderby: 'id',
                            order: 'asc',
                            per_page: perPage,
                            page,
                            _fields: [
                                'id',
                                'title',
                                'date',
                                'modified',
                                'link',
                                '_links.wp:featuredmedia',
                                '_links.wp:term',
                            ],
                            _embed: 'wp:featuredmedia,wp:term',
                        },
                    });
                    const posts = data.slice(mod);
                    resolve({ source, posts });
                }
                catch (error) {
                    reject(error);
                }
            }));
        });
        const sourcePosts = await Promise.all(getPosts);
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';
        const categories = [];
        sourcePosts.forEach(({ posts }) => {
            posts.forEach(post => {
                const { _embedded } = post;
                const terms = _embedded?.['wp:term'].flatMap(term => term) || [];
                const term = terms.find(term => term.taxonomy === 'category');
                const isExist = categories.some(category => category.slug === term?.slug);
                if (term && !isExist) {
                    categories.push({
                        slug: term.slug,
                        name: term.name,
                    });
                }
            });
        });
        let articleCategories = await trx.articleCategory.findMany({
            where: {
                slug: {
                    in: categories.map(category => category.slug),
                }
            }
        });
        const newCategories = categories.filter(category => !articleCategories.some(articleCategory => articleCategory.slug === category.slug));
        const newArticleCategories = await Promise.all(newCategories.map(newCategory => trx.articleCategory.create({ data: newCategory })));
        articleCategories = articleCategories.concat(newArticleCategories);
        sourcePosts.forEach(({ source, posts }) => {
            storePosts.push(new Promise(async (resolve) => {
                await trx.article.createMany({
                    data: posts.map(post => {
                        const { _embedded } = post;
                        const terms = _embedded?.['wp:term'].flatMap(term => term) || [];
                        const category = terms.find(term => term.taxonomy === 'category');
                        const articleCategory = articleCategories.find(({ slug }) => slug === category?.slug);
                        const tags = terms.filter(term => term.taxonomy === 'post_tag');
                        const date = luxon_1.DateTime.fromISO(post.date).toISO();
                        const modified = luxon_1.DateTime.fromISO(post.modified).toISO();
                        return {
                            id: (0, nanoid_1.nanoid)(12),
                            title: post.title.rendered.slice(0, 250),
                            image: _embedded?.['wp:featuredmedia']?.[0]?.source_url || null,
                            originArticleId: post.id,
                            articleCategoryId: articleCategory?.id,
                            tags: tags.map(tag => tag.name),
                            sourceUrl: post.link,
                            date,
                            modified: post.modified.startsWith('-0001') ? date : modified,
                            sourceId: source.id,
                        };
                    })
                });
                resolve();
            }));
        });
        await Promise.all(storePosts);
        return { message: 'success' };
    }, { timeout: 600000 });
    reply.send(data);
});
app.get('/videos', async (request, reply) => {
    const { prisma } = app;
    const channels = await prisma.channel.findMany({
        where: { deletedAt: null },
    });
    const videoIds = [];
    const scrapes = [];
    channels.forEach(channel => {
        ['videos', 'streams'].forEach(tab => {
            scrapes.push(new Promise(async (resolve) => {
                const url = `https://www.youtube.com/@${channel.customUrl}/${tab}`;
                const response = await axios_1.default.get(url);
                const initialDataString = response.data.match('>var ytInitialData = (.*);</script>');
                const initialData = JSON.parse(initialDataString[1]);
                const tabRenderer = {
                    videos: 1,
                    streams: 3,
                };
                const index = tabRenderer[tab];
                initialData.contents.twoColumnBrowseResultsRenderer.tabs[index].tabRenderer?.content?.richGridRenderer?.contents
                    .slice(0, 12)
                    .forEach(content => {
                    const { videoId } = content.richItemRenderer?.content.videoRenderer || {};
                    if (videoId) {
                        videoIds.push(videoId);
                    }
                });
                resolve();
            }));
        });
    });
    await Promise.all(scrapes);
    const perPage = 40;
    const totalPage = Math.ceil(videoIds.length / perPage);
    const data = await prisma.$transaction(async (trx) => {
        const promises = [];
        Array.from(new Array(totalPage).keys()).forEach(index => {
            const start = index * perPage;
            const end = (index + 1) * perPage;
            promises.push(new Promise(async (resolve) => {
                const { data: { items = [] } } = await (0, youtube_1.youtube)({
                    version: 'v3',
                    auth: process.env.YOUTUBE_API_KEY,
                }).videos.list({
                    part: ['id', 'snippet', 'contentDetails'],
                    maxResults: 40,
                    id: videoIds.slice(start, end).map(videoId => videoId),
                });
                const videos = items.filter(item => {
                    const { snippet } = item;
                    const isLiveOrUpcoming = ['upcoming', 'live'].includes(snippet.liveBroadcastContent);
                    return !isLiveOrUpcoming;
                });
                const inserts = videos.map(video => {
                    const { id, snippet, contentDetails } = video;
                    const data = {
                        id: id,
                        title: snippet.title,
                        description: snippet.description,
                        thumbnail: snippet.thumbnails.medium.url,
                        channelId: snippet.channelId,
                        liveBroadcastContent: snippet.liveBroadcastContent,
                        duration: contentDetails.duration,
                        publishedAt: luxon_1.DateTime.fromISO(snippet.publishedAt).toISO(),
                    };
                    return trx.video.upsert({
                        where: { id: id },
                        create: data,
                        update: data,
                    });
                });
                await Promise.all(inserts);
                resolve();
            }));
        });
        await Promise.all(promises);
        return { message: 'success' };
    }, { timeout: 12 * 60 * 1000 });
    reply.send(data);
});
app.get('/kajian-info', async (request, reply) => {
    const { prisma } = app;
    const instagramAccounts = await prisma.instagramAccount.findMany({
        where: {
            deletedAt: null,
        },
        include: {
            cities: true,
        },
    });
    const data = await prisma.$transaction(async (trx) => {
        const promises = [];
        instagramAccounts.forEach(({ id: instagramAccountId, username, cities }) => {
            promises.push(new Promise(async (resolve) => {
                const url = `https://www.instagram.com/api/v1/feed/user/${username}/username`;
                const { data: { items } } = await axios_1.default.get(url, {
                    params: { count: 60 },
                    headers: {
                        'x-ig-app-id': process.env.IG_APP_ID,
                    },
                });
                const [{ cityId }] = cities;
                await Promise.all(items.map(item => {
                    return new Promise(async (res) => {
                        const regex = /(http[s]?:\/\/[^\s]+)/gi;
                        const [mapUrl] = item.caption?.text.match(regex) || [];
                        const mapId = mapUrl?.split('/').pop();
                        let kajianLocationMap = null;
                        if (mapId) {
                            kajianLocationMap = await prisma.kajianLocationMap.findFirst({
                                where: {
                                    mapId,
                                },
                                include: {
                                    kajianLocation: {
                                        select: {
                                            id: true,
                                            cityId: true,
                                            lat: true,
                                            lng: true,
                                        },
                                    },
                                },
                            });
                            const isProduction = process.env.NODE_ENV === 'production';
                            if (!kajianLocationMap && isProduction) {
                                const token = process.env.TELEGRAM_ERROR_BOT_TOKEN;
                                const chatId = process.env.TELEGRAM_CHAT_ID;
                                const bot = new node_telegram_bot_api_1.default(token);
                                const message = `MapId untuk ${mapUrl} pada post https://instagram.com/p/${item.code} tidak ditemukan`;
                                await bot.sendMessage(chatId, message);
                            }
                        }
                        const images = [];
                        if (item.image_versions2) {
                            const [{ url }] = item.image_versions2.candidates.sort((a, b) => b.width - a.width);
                            images.push(url);
                        }
                        else if (item.carousel_media) {
                            item.carousel_media.forEach(media => {
                                const [{ url }] = media.image_versions2.candidates.sort((a, b) => b.width - a.width);
                                images.push(url);
                            });
                        }
                        for (const [i, image] of images.entries()) {
                            const id = `${item.code}${images.length > 1 ? `-${i + 1}` : ''}`;
                            await trx.kajianInfo.upsert({
                                where: { id },
                                create: {
                                    id,
                                    image,
                                    instagramAccountId,
                                    kajianLocationId: kajianLocationMap?.kajianLocationId,
                                    cityId: kajianLocationMap?.kajianLocation.cityId || cityId,
                                    lat: kajianLocationMap?.kajianLocation.lat,
                                    lng: kajianLocationMap?.kajianLocation.lng,
                                },
                                update: {},
                            });
                        }
                        res();
                    });
                }));
                resolve();
            }));
        });
        await Promise.all(promises);
        return { message: 'success' };
    }, { timeout: 12 * 60 * 1000 });
    reply.send(data);
});
// Start the server
const start = async () => {
    try {
        const port = Number(process.env.PORT || 3030);
        await app.listen({ port });
        console.log(`started server on 0.0.0.0:${port}`);
    }
    catch (err) {
        app.log.error(err);
        process.exit(1);
    }
};
start();
