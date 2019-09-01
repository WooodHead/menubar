const fetch = require('node-fetch')
const unescape = require('lodash.unescape')
const aws4 = require('aws4')
const querystring = require('querystring')
const crypto = require('crypto')
const redis = require('redis')

const {
  BASE_URI,
  PROJECT_ID,
  TOKEN,
  GRAPHQL_ENDPOINT,
  SES_SOURCE_ARN,
  SES_DESTINATION_ADDRESS,
  REDIS_URL
} = process.env

const client = redis.createClient(REDIS_URL)

const cache = {
  get (key) {
    return new Promise((resolve, reject) => client.get(`menubar/${key}`, (_, data) => resolve(JSON.parse(data))))
  },
  set (key, value) {
    return new Promise(resolve => client.set(`menubar/${key}`, JSON.stringify(value), (_, data) => resolve(data)))
  }
}

const hash = (key) => crypto.createHash('md5').update(key).digest('hex')

const createFetch = async ({ query, variables }) => {
  const key = hash(query)
  let json = await cache.get(key)
  if (!json) {
    const body = JSON.stringify({
      operationName: null,
      query: query,
      variables: variables || {}
    })
    const resp = await fetch(GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-type': 'application/json'
      },
      body: body
    })
    json = await resp.json()
    await cache.set(key, json)
  }

  return json
}

module.exports.sendEmail = (params) => {
  const opts = {
    service: 'ses',
    path: '/',
    method: 'POST',
    body: querystring.stringify({
      Action: 'SendEmail',
      Version: '2010-12-01',
      'Destination.ToAddresses.member.1': SES_DESTINATION_ADDRESS,
      'Message.Body.Html.Data': params.message,
      'Message.Body.Html.Charset': 'utf8',
      'Message.Body.Text.Data': params.message,
      'Message.Body.Text.Charset': 'utf8',
      'Message.Subject.Data': params.message.slice(0, 50),
      'Message.Subject.Charset': 'utf8',
      Source: 'no-reply@letterpost.co',
      'ReplyToAddresses.member.1': params.from,
      SourceArn: SES_SOURCE_ARN
    })
  }
  const signed = aws4.sign(opts, {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  })
  let url = `https://${signed.headers.Host}`

  if (process.env.AWS_SESSION_TOKEN) {
    url += `&X-Amz-Security-Token=${encodeURIComponent(process.env.AWS_SESSION_TOKEN)}`
  }

  fetch(url, signed)
    .then(resp => resp.text())
}

module.exports.fetchPage = (req, res) => {
  const params = req.params || {}
  const page = parseInt(params.page || 0)
  const offset = page * 10
  return createFetch({
    query: `{
      feed(limit: 10, offset: ${offset}, projectId: "${PROJECT_ID}") {
        count
        posts {
          id
          title
          slug
          publishedAt
          createdAt
          excerpt
          coverImage {
            id
            url
          }
          tags {
            name
            id
          }
        }
      }
    }`
  })
    .then(({ data }) => {
      const next = page + 1
      const prev = Math.max(1, page - 1)
      const props = {}
      props.posts = data.feed.posts
      props.page = page
      props.next = next
      props.prev = prev
      props.meta = {}
      props.meta.canonical = `${BASE_URI}${page}`
      return props
    })
}

module.exports.fetchPost = (req, res) => {
  const { slug } = req.params
  return createFetch({
    query: `{
      post(slug: "${slug}", projectId: "${PROJECT_ID}") {
        id,
        title
        slug
        publishedAt
        createdAt
        excerpt
        encodedHtml
        coverImage {
          url
        }
      }
    }`
  })
    .then(({ data }) => {
      return {
        ...data,
        post: {
          ...data.post,
          content: data.post.encodedHtml
            ? Buffer.from(data.post.encodedHtml, 'base64').toString('utf8')
            : unescape(data.post.html)
        },
        meta: {
          canonical: `${BASE_URI}${slug}`,
          title: data.post.title,
          excerpt: data.post.excerpt
        }
      }
    })
}

module.exports.fetchRepositories = async (variables = { after: null, first: 10, last: null, before: null }) => {
  const { data } = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      'Authorization': `bearer ${process.env.GITHUB_TOKEN}`,
      'Content-type': 'application/json'
    },
    body: JSON.stringify({
      variables: variables,
      query: `query($first: Int, $last: Int, $before: String, $after: String) {
        viewer {
          name
          repositories(
            before: $before,
            after: $after,
            first: $first,
            last: $last,
            orderBy: { field: UPDATED_AT, direction: DESC }
          ) {
            nodes {
              id
              name
              description
              homepageUrl
              resourcePath
              languages(first: $first) {
                nodes {
                  id
                  name
                }
              }
              stargazers {
                totalCount
              }
            }
            pageInfo {
              endCursor
              hasNextPage
              hasPreviousPage
            }
          }
        }
      }`
    })
  }).then(resp => resp.json())
  return data.viewer.repositories
}

module.exports.createFetch = createFetch
