import { youtube } from '@googleapis/youtube';
import { Prisma, Source } from '@prisma/client';
import axios, { AxiosRequestConfig } from 'axios';
import * as dotenv from 'dotenv'
import fastify from 'fastify';
import { DateTime } from 'luxon';
import { nanoid } from 'nanoid';
import { Post, WpTerm, YoutubeInitialData } from './interfaces';
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
