module.exports = {
	presets: [
		[
			'@babel/env',
			{
				targets: {
					node: 'current'
				}
			}
		],
		'@babel/typescript'
	],
	plugins: [
		'@babel/proposal-class-properties',
		[
			'@babel/proposal-object-rest-spread',
			{
				useBuiltIns: true
			}
		]
	]
};
