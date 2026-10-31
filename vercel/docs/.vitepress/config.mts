import { defineConfig } from 'vitepress'

export default defineConfig({
  lang: 'zh-CN',
  title: 'Anpio Collab',
  titleTemplate: ':title · Anpio Collab',
  description: '面向个人与小型团队的智能体协作空间：任务、验收、经验、信箱与智能体接入。',
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ['link', { rel: 'icon', href: '/logo.svg', type: 'image/svg+xml' }],
    ['meta', { name: 'theme-color', content: '#146b55' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'Anpio Collab' }],
    ['meta', { property: 'og:title', content: 'Anpio Collab 文档' }],
    ['meta', { property: 'og:description', content: '你定目标与验收条件，智能体在授权范围内执行，只有通过验收的结论才会沉淀成经验。' }]
  ],
  themeConfig: {
    logo: '/logo.svg',
    siteTitle: 'Anpio Collab',
    nav: [
      { text: '指南', link: '/guide/vision', activeMatch: '/guide/(vision|features|operations|getting-started)' },
      { text: '智能体', link: '/guide/embedded-agent', activeMatch: '/guide/(embedded-agent|external-agent)' },
      { text: '部署', link: '/guide/deployment' },
      { text: 'API', link: '/api/reference' }
    ],
    sidebar: {
      '/guide/': [
        {
          text: '认识产品',
          items: [
            { text: '理念与愿景', link: '/guide/vision' },
            { text: '功能总览', link: '/guide/features' }
          ]
        },
        {
          text: '开始使用',
          items: [
            { text: 'Getting Started', link: '/guide/getting-started' },
            { text: '操作指南', link: '/guide/operations' }
          ]
        },
        {
          text: '接入智能体',
          items: [
            { text: '平台内嵌 Agent', link: '/guide/embedded-agent' },
            { text: '外部 Agent 接入', link: '/guide/external-agent' }
          ]
        },
        {
          text: '部署与参考',
          items: [
            { text: '部署指南', link: '/guide/deployment' },
            { text: 'API Reference', link: '/api/reference' }
          ]
        }
      ],
      '/api/': [
        {
          text: '参考',
          items: [{ text: 'API Reference', link: '/api/reference' }]
        }
      ]
    },
    socialLinks: [],
    outline: { level: [2, 3], label: '本页目录' },
    search: {
      provider: 'local',
      options: {
        translations: {
          button: {
            buttonText: '搜索文档',
            buttonAriaLabel: '搜索文档'
          },
          modal: {
            displayDetails: '显示详情',
            resetButtonTitle: '清除查询',
            backButtonTitle: '返回',
            noResultsText: '没有找到结果',
            footer: {
              selectText: '选择',
              navigateText: '切换',
              closeText: '关闭'
            }
          }
        }
      }
    },
    docFooter: { prev: '上一篇', next: '下一篇' },
    lastUpdated: {
      text: '最后更新',
      formatOptions: { dateStyle: 'medium', timeStyle: 'short' }
    },
    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '目录',
    darkModeSwitchLabel: '主题',
    lightModeSwitchTitle: '切换到浅色模式',
    darkModeSwitchTitle: '切换到深色模式',
    langMenuLabel: '语言',
    externalLinkIcon: true,
    footer: {
      message: '面向个人与小型团队的智能体协作空间',
      copyright: 'Anpio Collab'
    }
  }
})
