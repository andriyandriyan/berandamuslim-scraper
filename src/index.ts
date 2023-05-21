import { youtube } from '@googleapis/youtube';
import { KajianLocationMap, Prisma, Source } from '@prisma/client';
import axios, { AxiosRequestConfig } from 'axios';
import * as dotenv from 'dotenv';
import fastify from 'fastify';
import { DateTime } from 'luxon';
import { nanoid } from 'nanoid';
import TelegramBot from 'node-telegram-bot-api';
import { InstagramPostData, Post, WpTerm, YoutubeInitialData } from './interfaces';
import prismaPlugin from './plugins/prisma';

dotenv.config();

const app = fastify({
  logger: process.env.NODE_ENV === 'development',
});

app.register(prismaPlugin);

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
  const data = await prisma.$transaction(async trx => {
    const getPosts: Promise<{ source: Source; posts: Post[] }>[] = [];
    const storePosts: Promise<void>[] = [];
    sources.forEach(source => {
      getPosts.push(
        new Promise<{ source: Source; posts: Post[] }>(async (resolve, reject) => {
          const baseURL = `https://${source.url}`;
          const url = 'wp-json/wp/v2/posts';
          const config: AxiosRequestConfig = {
            headers: { 'Accept-Encoding': 'gzip,deflate,compress' },
            baseURL,
          };
          const { headers } = await axios.get(url, {
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
            const { data } = await axios.get<Post[]>(url, {
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
          } catch (error) {
            reject(error);
          }
        })
      );
    });
    const sourcePosts = await Promise.all(getPosts);
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';
    const categories: Pick<WpTerm, 'slug' | 'name'>[] = [];
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
    const newArticleCategories = await Promise.all(
      newCategories.map(newCategory => trx.articleCategory.create({ data: newCategory }))
    );
    articleCategories = articleCategories.concat(newArticleCategories);

    sourcePosts.forEach(({ source, posts }) => {
      storePosts.push(
        new Promise<void>(async resolve => {
          await trx.article.createMany({
            data: posts.map(post => {
              const { _embedded } = post;
              const terms = _embedded?.['wp:term'].flatMap(term => term) || [];
              const category = terms.find(term => term.taxonomy === 'category');
              const articleCategory = articleCategories.find(
                ({ slug }) => slug === category?.slug
              );
              const tags = terms.filter(term => term.taxonomy === 'post_tag');
              const date = DateTime.fromISO(post.date).toISO();
              const modified = DateTime.fromISO(post.modified).toISO();
              return {
                id: nanoid(12),
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
        })
      );
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
  const videoIds: string[] = [];
  const scrapes: Promise<void>[] = [];
  channels.forEach(channel => {
    ['videos', 'streams'].forEach(tab => {
      scrapes.push(new Promise<void>(async resolve => {
        const url = `https://www.youtube.com/@${channel.customUrl}/${tab}`;
        const response = await axios.get<string>(url);
        const initialDataString = response.data.match('>var ytInitialData = (.*);</script>');
        const initialData: YoutubeInitialData = JSON.parse(initialDataString![1]);
        const tabRenderer: { [key: string]: number } = {
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
  const data = await prisma.$transaction(async trx => {
    const promises: Promise<void>[] = [];
    Array.from(new Array(totalPage).keys()).forEach(index => {
      const start = index * perPage;
      const end = (index + 1) * perPage;
      promises.push(new Promise<void>(async resolve => {
        const { data: { items = [] } } = await youtube({
          version: 'v3',
          auth: process.env.YOUTUBE_API_KEY,
        }).videos.list({
          part: ['id', 'snippet', 'contentDetails'],
          maxResults: 40,
          id: videoIds.slice(start, end).map(videoId => videoId),
        });
        const videos = items.filter(item => {
          const { snippet } = item;
          const isLiveOrUpcoming = ['upcoming', 'live'].includes(snippet!.liveBroadcastContent!);
          return !isLiveOrUpcoming;
        });
        const inserts: Promise<any>[] = videos.map(video => {
          const { id, snippet, contentDetails } = video;
          const data: Prisma.VideoUpsertArgs['create'] = {
            id: id!,
            title: snippet!.title!,
            description: snippet!.description!,
            thumbnail: snippet!.thumbnails!.medium!.url!,
            channelId: snippet!.channelId!,
            liveBroadcastContent: snippet!.liveBroadcastContent!,
            duration: contentDetails!.duration!,
            publishedAt: DateTime.fromISO(snippet!.publishedAt!).toISO(),
          }
          return trx.video.upsert({
            where: { id: id! },
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
  const data = await prisma.$transaction(async trx => {
    const promises: Promise<void>[] = [];
    instagramAccounts.forEach(({ id: instagramAccountId, username, cities }) => {
      promises.push(new Promise(async resolve => {
        const url = `https://www.instagram.com/api/v1/feed/user/${username}/username`;
        const { data: { items } } = await axios.get<InstagramPostData>(url, {
          params: { count: 60 },
          headers: {
            'x-ig-app-id': process.env.IG_APP_ID,
            'cookie': 'mid=Y8yDPQAEAAGJ9lmxpGfxt-Xt6QBS; ig_did=E18586E8-0DAC-4D73-B684-2453E4946BF4; ig_nrcb=1; datr=jPHPYzrMN7mZBllCrEQYBnCK; fbm_124024574287414=base_domain=.instagram.com; csrftoken=zECzR6H2wFzkgO0N4lrxR4IhdjQr9e2V; ds_user_id=59577458037; shbid="3941\05459577458037\0541716188468:01f713ca5b237b95efa2bb1978c61e9dca93f8bc0fe28b4c7fd5319990943986f1ba77ae"; shbts="1684652468\05459577458037\0541716188468:01f791df2442559412cf96d1269c675ccf75e0434eadcc26fca3dedba9fb979abd05d001"; sessionid=59577458037%3Am7VSNwPRuwR6un%3A15%3AAYelMd7vbpHMhUc0AwOwMosB2LAf9qi9x6e65eEgHg; fbsr_124024574287414=54haVYaMEPZMyacc8ODJrZRi0T0VUj-nCm5W8Ig6pJA.eyJ1c2VyX2lkIjoiMTAwMDA2NTIzNzQ3OTc2IiwiY29kZSI6IkFRRE5vOVVwSW5NR25KUnREOS1UN0l0N3RSR1R3dHoyamNkeUNGYWNvWm5jSDloazBSVlYxTFZ1UVVmdDQzNDBiemw5Wm1tVVhXWVV4UTZPYkloRjcwNDR1eTNBQWVrMG5WYnAtMUU2VVF3THY2a3kwUjZNQUM4VmFKLXdKc0FnbksxY3haUW5IMTEtYldRazFzTkJjMFBDZ0g5MzJTRmxRc2NXazZQRmMwVm9WbkV2Y2VCUXEzUmdIZi12ZDB4eHo4WXN4RThhUmN5NFl5Q2tGeTJabk85enVwUmhPRmlaenVRS3l5VW5vaW5KWUhUa0R5aFRRS1BDRGFGOW1LVDNncWNBYmQyU2dsSW81U2sxNGN2aENXZGRVbmhCbzNDUFdXdGNjLTBZeHRYRTMyX2F6anJINHVLZDVsYS1BcXp1ZG00Iiwib2F1dGhfdG9rZW4iOiJFQUFCd3pMaXhuallCQUIxUDVGR0NXMDNRYmg5cVRBWkJES2IyMnYxcnRaQU5VZE9ZbU5mWEJGeU5xU0xDbkJtVEU0dEVLS1hqVVpDY3g4Sk5xWkJXQ3lweEFsTDJBcDlIUTRwWkFqWFg5cmRPeHZ1UjdUOVpDQ1pBNklDeWVweEFaQlVobXo2UWphY1pCZ1VucW5haVdvdmc5NnhueWtmWDdaQTRNckNzZVhDMFhaQ1hlNDM5ZzdrN2JvNW51d24xUkwySWNrWkQiLCJhbGdvcml0aG0iOiJITUFDLVNIQTI1NiIsImlzc3VlZF9hdCI6MTY4NDY1ODEyMH0; fbsr_124024574287414=YBdLEIvWcjHJSXE3nC4oDQ-9f2HOsjKDrwFc2015h5E.eyJ1c2VyX2lkIjoiMTAwMDA2NTIzNzQ3OTc2IiwiY29kZSI6IkFRRERwSS1xeE9lSm1SUGFRQ0JWOFZHMGVKc0xMSWd1Q2pSY3NMcU9OQy1LdWZTVWNBQnBjOUk2SXR4eEZGQkgxX3psT0lRd0FyTlotaEV0ZlFwYmJZZVpsNElCR3lnbTYtT1NLcjdZQ0xQSjE2cVZKWGtjX1BhSy16bm1hYW02c2hTRHVNaU0zT3FMbFk2MXREV3BkOGg1eWRXOUNwV3BtSVhMbW9YLTJydHNJelpoMnAxSlBxeXo3U2dla0xOTERqZGtCbW9JVE8zMHl3UGxjVXI2b1ZubG0zMjdDcmkzWHZxbWFCZVlGRFNERGVkZkFwcFBZam9FdDg0VUc5RDAteUVyb3pITW0xS2xpbXlrUVFNaDhubm1zMHNPdFUzOE9FWDhWc3N6YlVUdjk2M1lGNkdqTGdrVVhqTWdHaG9ydDJzIiwib2F1dGhfdG9rZW4iOiJFQUFCd3pMaXhuallCQVByVmJVNzFtSlh6b2xESWNaQXBNWkJaQmZ5WkF1Uk92Z00wRE5LNTV6YWxJWGVSTUc1OVRuSzBZNXZYQ2hVRGdvQnFIc0JTZ0hLMG5TQzc4eXRsbDNhMjR3cEdFTzczcHhXekZoYXhIQTc3ajJZRU1DVm9JWkJ4clhKQVpDdlZEWkF3eGtCemhPUWZaQTBkbndlcnJiRzVKSnlVa0pwOFZhaXE2enJwUDZJcFpCSUlkYjV4N2JMVVpEIiwiYWxnb3JpdGhtIjoiSE1BQy1TSEEyNTYiLCJpc3N1ZWRfYXQiOjE2ODQ2Nzc0NzR9; rur="CCO\05459577458037\0541716213499:01f72a15fef6144617b3ee83a6b9c6eec807be8a63dc8e26472583a3d699aa3a452d3506"'
          },
        });
        const [{ cityId }] = cities;
        await Promise.all(items.map(item => {
          return new Promise<void>(async res => {
            const regex = /(http[s]?:\/\/[^\s]+)/gi;
            const [mapUrl] = item.caption?.text.match(regex) || [];
            const mapId = mapUrl?.split('/').pop()
            let kajianLocationMap: (KajianLocationMap & {
              kajianLocation: {
                id: string;
                lat: Prisma.Decimal;
                lng: Prisma.Decimal;
                cityId: string;
              };
            }) | null = null;
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
                const token = process.env.TELEGRAM_ERROR_BOT_TOKEN!;
                const chatId = process.env.TELEGRAM_CHAT_ID!;
                const bot = new TelegramBot(token);
                const message = `MapId untuk ${mapUrl} pada post https://instagram.com/p/${item.code} tidak ditemukan`;
                await bot.sendMessage(chatId, message);
              }
            }
            const images: string[] = []
            if (item.image_versions2) {
              const [{ url }] = item.image_versions2.candidates.sort((a, b) => b.width - a.width);
              images.push(url);
            } else if (item.carousel_media) {
              item.carousel_media.forEach(media => {
                const [{ url }] = media.image_versions2.candidates.sort((a, b) => b.width - a.width); images.push(url);
              })
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
    await app.listen({ port })
    console.log(`started server on 0.0.0.0:${port}`)
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

start()
