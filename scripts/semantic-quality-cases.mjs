export const semanticQualityCases = [
  {
    query: '用户喝咖啡是否加糖？',
    relevant: '用户喝咖啡只喝无糖拿铁。',
    irrelevant: '会议室咖啡机需要维修。',
  },
  {
    query: '用户的家庭住址是什么？',
    relevant: '用户家庭住址是上海浦东新区。',
    irrelevant: '公司办公地址是北京朝阳区。',
  },
  {
    query: '用户当前的工作是什么？',
    relevant: '用户当前工作是后端工程师。',
    irrelevant: '招聘职位是后端工程师。',
  },
  {
    query: '用户的宠物叫什么名字？',
    relevant: '用户的宠物名叫豆包。',
    irrelevant: '宠物禁止进入办公区。',
  },
  {
    query: '首次启动应有什么数据？',
    relevant: '产品首次启动必须保持空数据。',
    irrelevant: '演示数据保存在测试环境。',
  },
  {
    query: '用户最喜欢什么甜点？',
    relevant: '用户最喜欢的甜点是提拉米苏。',
    irrelevant: '咖啡店甜点包含提拉米苏。',
  },
  {
    query: '用户喜欢什么编程语言？',
    relevant: '用户最喜欢的编程语言是 TypeScript。',
    irrelevant: 'Python 入门教程已归档。',
  },
  {
    query: '用户常用哪个 IDE？',
    relevant: '用户常用的 IDE 是 VS Code。',
    irrelevant: 'VS Code 插件市场发生故障。',
  },
  {
    query: '用户偏好的回复语言是什么？',
    relevant: '用户要求使用中文回复。',
    irrelevant: '项目加入了中文翻译文件。',
  },
  {
    query: '出行交通方式首选什么？',
    relevant: '出差时优先乘坐高铁。',
    irrelevant: '高铁站设备正在检修。',
  },
  {
    query: '平时几点上班？',
    relevant: '每天早上九点开始办公。',
    irrelevant: '办公楼九点开始访客登记。',
  },
  {
    query: '饮食要避开什么坚果？',
    relevant: '用户对花生严重过敏。',
    irrelevant: '仓库新到一批花生原料。',
  },
  {
    query: '外观偏好是否为夜间主题？',
    relevant: '用户界面采用深色模式。',
    irrelevant: '夜间主题文件需要重新打包。',
  },
  {
    query: '当前居住城市是哪里？',
    relevant: '用户住在上海浦东。',
    irrelevant: '上海浦东办公室正在装修。',
  },
  {
    query: '用户所在时区的 UTC 偏移如何计算？',
    relevant: '用户时区是 Asia/Shanghai。',
    irrelevant: '时区转换库需要升级。',
  },
  {
    query: '回答应详细还是精炼？',
    relevant: '回复要简洁直接。',
    irrelevant: '精炼版项目总结已归档。',
  },
  {
    query: '服务采用什么技术栈？',
    relevant: '后端服务使用 Node.js 和 SQLite。',
    irrelevant: 'Node.js 入门教程下载完成。',
  },
  {
    query: '例会安排在什么时候？',
    relevant: '每周一下午三点召开例会。',
    irrelevant: '例会室的投影仪需要维修。',
  },
];
